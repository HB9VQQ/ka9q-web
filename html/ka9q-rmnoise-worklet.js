/**
 * ka9q-rmnoise-worklet.js — RMNoise AudioWorklet processor
 * HB9VQQ Edition — Phase 4b
 *
 * Runs on the real-time audio thread.  Receives matched (original, denoised)
 * frame pairs via MessagePort, aligned by frame number, then upsamples from
 * INPUT_RATE (12 kHz) to the AudioContext rate and mixes according to mixRatio.
 *
 * Echo-free guarantee: origMap and denMap store frames keyed by the wire-
 * protocol frameNumber.  A pair is only committed to the output queues once
 * BOTH sides have arrived for the same frameNum.  origOut[i] and denOut[i]
 * therefore always correspond to identical audio content — one original,
 * one denoised — so mixing them at any ratio produces no comb-filter echo.
 *
 * MessagePort protocol (from main thread):
 *   { type: 'orig',   frameNum: Number,  samples: Float32Array }  — from rmnoise.js send loop
 *   { type: 'den',    frameNum: Number,  samples: Float32Array }  — from rmnoise.js dc.onmessage
 *   { type: 'mix',    value: number }     — 0.0 (all original) … 1.0 (all denoised)
 *   { type: 'bypass', value: boolean }    — true → pass original regardless of mix
 *   { type: 'reset' }                     — on disconnect: clear all queues and state
 */

'use strict';

const INPUT_RATE   = 12000;   // ka9q-web PCM rate for SSB/CW (the only modes where RMNoise runs)
const DEN_RATE     = 8000;    // RMNoise wire protocol rate — den frames arrive at this rate
const PAIR_MAP_MAX = 256;     // max unmatched frames in each map before eviction

// AI model lookahead compensation — mirrors rmnoise.com audio-mixer-processor2.js exactly.
// Their delaySamples8k=300, upsampleLookaheadSamples=10 → delay48k=(300+10)*6=1860 samples.
// The AI model processes audio with a 300-sample lookahead at 8kHz (= 37.5ms).
// Without compensating delay on the orig side, blending orig (undelayed) with
// denoised (effectively delayed 37.5ms by the AI) produces echo at exactly 37.5ms.
const DELAY_8K   = 300;   // AI lookahead in 8kHz samples (from their delaySamples8k)
const DELAY_UPSAMPLE_LOOKAHEAD = 10;  // from their upsampleLookaheadSamples
// orig delay at 48kHz = (DELAY_8K + DELAY_UPSAMPLE_LOOKAHEAD) * (48000/8000) = 1860 samples
const ORIG_DELAY_48K = (DELAY_8K + DELAY_UPSAMPLE_LOOKAHEAD) * (48000 / DEN_RATE);  // 1860

/**
 * LookaheadDelay — delays a stream by a fixed number of samples.
 * Mirrors LookaheadDelay in rmnoise.com audio-mixer-processor2.js exactly.
 * Pre-filled with silence; on each call returns the delayed output.
 */
class LookaheadDelay {
    constructor(numSamples) {
        this.buf = new Float32Array(numSamples);
    }

    // Delay input frame by buf.length samples.
    // Correctly handles any frame size — including frame.length > buf.length.
    delay(frame) {
        const n    = frame.length;
        const dLen = this.buf.length;
        const out  = new Float32Array(n);

        // out[i] = buf[i]        for i < dLen  (from delay buffer)
        //        = frame[i-dLen] for i >= dLen  (from current frame)
        for (let i = 0; i < n; i++) {
            out[i] = i < dLen ? this.buf[i] : frame[i - dLen];
        }

        // Update delay buffer with the last dLen samples of (buf + frame)
        if (n >= dLen) {
            this.buf.set(frame.subarray(n - dLen));
        } else {
            this.buf.copyWithin(0, n);
            this.buf.set(frame, dLen - n);
        }

        return out;
    }
}

class RMNoiseProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        // Frame-number keyed stores (Number keys, Float32Array at INPUT_RATE values)
        this._origMap = new Map();
        this._denMap  = new Map();

        // Output queues at AudioContext sample rate (e.g. 48 000 Hz)
        // These grow only when a matched pair is committed, so they stay in lock-step.
        this._origOut = new Float32Array(0);
        this._denOut  = new Float32Array(0);

        // Resampling ratios
        // orig: INPUT_RATE (12kHz) → sampleRate (48kHz), ratio = 12000/48000 = 0.25
        // den:  DEN_RATE   (8kHz)  → sampleRate (48kHz), ratio = 8000/48000  = 0.1667
        this._ratio    = INPUT_RATE / sampleRate;   // orig: 12kHz → 48kHz
        this._ratioDen = DEN_RATE   / sampleRate;   // den:   8kHz → 48kHz

        // AI lookahead compensation: delay orig by ORIG_DELAY_48K samples (1860 @ 48kHz)
        // to match the AI model's built-in lookahead of 300 samples @ 8kHz.
        // Without this, orig is 37.5ms ahead of denoised → echo at exactly 37.5ms.
        this._origDelay = new LookaheadDelay(ORIG_DELAY_48K);

        // Mix state
        this._mix    = 1.0;    // 0.0 = all original, 1.0 = all denoised
        this._bypass = false;

        // Priming: don't output until we have 250 ms of denoised buffered
        this._primed      = false;
        this._primeTarget = Math.round(0.25 * sampleRate);   // samples at ctx rate

        this.port.onmessage = (e) => this._onMsg(e.data);
    }

    // ── MessagePort handler (runs on audio thread) ─────────────────────────────

    _onMsg(msg) {
        switch (msg.type) {
            case 'orig':
                this._origMap.set(msg.frameNum, msg.samples);
                this._tryMatch();
                break;

            case 'den':
                this._denMap.set(msg.frameNum, msg.samples);
                this._tryMatch();
                break;

            case 'mix':
                this._mix = typeof msg.value === 'number' ? msg.value : 1.0;
                break;

            case 'bypass':
                this._bypass = !!msg.value;
                break;

            case 'reset':
                this._origMap.clear();
                this._denMap.clear();
                this._origOut = new Float32Array(0);
                this._denOut  = new Float32Array(0);
                this._primed  = false;
                this._origDelay = new LookaheadDelay(ORIG_DELAY_48K);
                break;

            case 'debug':
                this.port.postMessage({
                    type:      'debugReply',
                    origOut:   this._origOut.length,
                    denOut:    this._denOut.length,
                    origMap:   this._origMap.size,
                    denMap:    this._denMap.size,
                    primed:    this._primed,
                    mix:       this._mix,
                    sampleRate: sampleRate,
                });
                break;
        }
    }

    // ── Pair matching ──────────────────────────────────────────────────────────
    //
    // Iterate origMap in insertion order (= frameNum ascending).  For each
    // frame that also has a matching entry in denMap, upsample both from
    // INPUT_RATE to ctx rate and append to the output queues.
    //
    // Because frames arrive chronologically (network RTT is stable enough that
    // the server never reorders frames), origMap insertion order matches frame
    // number order.  The output queues therefore grow in monotonic frame order.

    _tryMatch() {
        for (const [fn, orig] of this._origMap) {
            if (!this._denMap.has(fn)) continue;

            const den = this._denMap.get(fn);
            this._origMap.delete(fn);
            this._denMap.delete(fn);

            // Upsample den (8kHz→48kHz) and orig (12kHz→48kHz) using separate ratios
            const denUp  = this._upsampleDen(den);
            const origUp = this._upsample(orig);

            // Apply AI lookahead delay to orig: 1860 samples @ 48kHz = 38.75ms.
            // Compensates for the AI model's built-in 300-sample lookahead @ 8kHz
            // so orig and denoised are time-aligned when blended.
            const origDelayed = this._origDelay.delay(origUp);

            const mergeOrig = new Float32Array(this._origOut.length + origDelayed.length);
            mergeOrig.set(this._origOut);
            mergeOrig.set(origDelayed, this._origOut.length);
            this._origOut = mergeOrig;

            const mergeDen = new Float32Array(this._denOut.length + denUp.length);
            mergeDen.set(this._denOut);
            mergeDen.set(denUp, this._denOut.length);
            this._denOut = mergeDen;
        }

        // Evict stale unmatched entries to bound memory.
        // A frame is "stale" if it has been waiting longer than PAIR_MAP_MAX frames.
        // This can happen if the server drops a frame on one side.
        if (this._origMap.size > PAIR_MAP_MAX) {
            const stale = this._origMap.keys().next().value;
            this._origMap.delete(stale);
        }
        if (this._denMap.size > PAIR_MAP_MAX) {
            const stale = this._denMap.keys().next().value;
            this._denMap.delete(stale);
        }
    }

    // ── Linear-interpolation upsampler: INPUT_RATE → AudioContext rate ─────────
    //
    // Stateless per-frame linear interpolation.  Sufficient quality for voice
    // at the target use case (SSB/CW, 12 kHz → 48 kHz upsampling).

    _upsample(input) {
        const ratio  = this._ratio;
        const outLen = Math.round(input.length / ratio);
        const out    = new Float32Array(outLen);
        const inLen  = input.length;

        for (let i = 0; i < outLen; i++) {
            const pos  = i * ratio;
            const idx  = Math.floor(pos);
            const frac = pos - idx;
            const a    = idx     < inLen ? input[idx]     : 0.0;
            const b    = idx + 1 < inLen ? input[idx + 1] : 0.0;
            out[i] = a + frac * (b - a);
        }
        return out;
    }

    // Upsample den from DEN_RATE (8kHz) → sampleRate (48kHz).
    // Uses _ratioDen (= 8000/48000) instead of _ratio (= 12000/48000).
    // Keeps den on a single resampling step, avoiding the group-delay mismatch
    // that arose from the intermediate 8kHz→12kHz Lanczos step in dc.onmessage.
    _upsampleDen(input) {
        const ratio  = this._ratioDen;
        const outLen = Math.round(input.length / ratio);
        const out    = new Float32Array(outLen);
        const inLen  = input.length;

        for (let i = 0; i < outLen; i++) {
            const pos  = i * ratio;
            const idx  = Math.floor(pos);
            const frac = pos - idx;
            const a    = idx     < inLen ? input[idx]     : 0.0;
            const b    = idx + 1 < inLen ? input[idx + 1] : 0.0;
            out[i] = a + frac * (b - a);
        }
        return out;
    }

    // ── Real-time audio output ─────────────────────────────────────────────────

    process(inputs, outputs) {
        const out = outputs[0];
        if (!out || !out[0]) return true;
        const ch = out[0];
        const N  = ch.length;   // 128 samples per block

        // Priming: wait until we have enough denoised to absorb network jitter
        if (!this._primed) {
            if (this._denOut.length >= this._primeTarget) {
                this._primed = true;
            } else {
                return true;   // output silence while filling
            }
        }

        // Bypassed: worklet outputs silence, pcm-player plays raw audio through gainNode.
        if (this._bypass) {
            // Drain queues to prevent backlog building during bypass
            if (this._origOut.length >= N) this._origOut = this._origOut.subarray(N);
            if (this._denOut.length  >= N) this._denOut  = this._denOut.subarray(N);
            return true;   // ch stays zero-filled = silence
        }

        const mix = this._mix;

        if (mix >= 1.0) {
            // 100% denoised — fast path, no blend
            if (this._denOut.length >= N) {
                ch.set(this._denOut.subarray(0, N));
                this._denOut  = this._denOut.subarray(N);
                // Drain origOut in lock-step to maintain queue alignment
                if (this._origOut.length >= N) this._origOut = this._origOut.subarray(N);
            }
        } else if (mix <= 0.0) {
            // 100% original — fast path, no blend
            if (this._origOut.length >= N) {
                ch.set(this._origOut.subarray(0, N));
                this._origOut = this._origOut.subarray(N);
                if (this._denOut.length >= N) this._denOut = this._denOut.subarray(N);
            }
        } else {
            // Blend — only when both queues have data
            if (this._origOut.length >= N && this._denOut.length >= N) {
                for (let i = 0; i < N; i++) {
                    ch[i] = this._origOut[i] * (1.0 - mix) + this._denOut[i] * mix;
                }
                this._origOut = this._origOut.subarray(N);
                this._denOut  = this._denOut.subarray(N);
            }
            // else: output silence (both queues must starve simultaneously — rare)
        }

        return true;
    }
}

registerProcessor('rmnoise-processor', RMNoiseProcessor);
