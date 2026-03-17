/**
 * rmnoise.js — RMNoise AI denoising for UberSDR web client
 *
 * HB9VQQ adaptation for ka9q-web fork (2026-03-17):
 *   - window.currentMode replaced with document.getElementById('mode')?.value
 *   - Proxy URL unchanged (/api/rmnoise/credentials — relative, served by nginx)
 *   - All element IDs match radio.html modal (§36.5)
 *   - Mode hook wired from hb9vqq-init.js (§36.6), not from this file
 *
 * Protocol (reverse-engineered from audio-mixer-processor2.js):
 *   - Audio sent/received at 8 kHz int16 PCM
 *   - Each frame: 20-byte header + int16 PCM samples
 *   - Header: frameNumber (uint64 LE) + timestamp (uint64 LE) + audioScale (uint32 LE)
 *   - audioScale = floor(32767 / max_abs_value)  [normalisation factor]
 *   - Frame size: 384 samples @ 8 kHz = 64 ms
 *
 * Mirrors clients/python/rmnoise_denoise.py + rmnoise_window.py
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────
const RM_RATE   = 8000;   // RMNoise wire protocol sample rate
const RM_FRAME  = 384;    // 64 ms at 8 kHz
const RM_SERVER = 'wss://s2.rmnoise.com:8766';
// RM_BASE (https://rmnoise.com) is no longer used for fetch() calls — the Go
// server-side CORS proxy handles those.  RM_SERVER is still used for WebSocket.

// ── DelayBuffer ────────────────────────────────────────────────────────────────
//
// [HB9VQQ] Phase 4b: Circular ring buffer that delays audio by a variable number
// of samples.  Used to time-align the original audio with the denoised audio so
// that blending them at any mix ratio produces no echo.
//
// Why this is echo-free:
//   The denoised audio returned by rmNoise_process() corresponds to audio that
//   was sent to the server ~RTT ms ago.  If we blend it with the *current*
//   original audio we get two copies of different moments → echo.
//   DelayBuffer.process() reads back from the ring buffer `delaySamples` ago,
//   so both signals correspond to the same moment in time.
//
// RTT adaptivity: delaySamples = lastLatencyMs * sampleRate / 1000.
//   The read pointer automatically adjusts each call as RTT changes.
//   No explicit tracking or re-priming required.
//
class DelayBuffer {
    /**
     * @param {number} maxSamples  maximum delay in samples (ring buffer size)
     */
    constructor(maxSamples) {
        this.buf  = new Float32Array(maxSamples);
        this.size = maxSamples;
        this.wPos = 0;
    }

    /**
     * Write `input` into the ring buffer, then read back `delaySamples` ago.
     * Both write and read advance by input.length on each call.
     *
     * @param {Float32Array} input
     * @param {number}       delaySamples  must be < this.size
     * @returns {Float32Array}  delayed copy, same length as input
     */
    process(input, delaySamples) {
        const n     = input.length;
        const out   = new Float32Array(n);
        const delay = Math.max(n, Math.min(Math.round(delaySamples), this.size - 1));
        const size  = this.size;

        for (let i = 0; i < n; i++) {
            const w = this.wPos % size;
            this.buf[w] = input[i];
            const r = ((this.wPos - delay + size * 4) % size);
            out[i] = this.buf[r];
            this.wPos++;
        }
        return out;
    }

    reset() {
        this.buf.fill(0);
        this.wPos = 0;
    }
}

// ── OversizeBuffer ─────────────────────────────────────────────────────────────
//
// Adapted from the known-good audio_mixer_processor.js reference implementation.
//
// A windowed-sinc (Lanczos) resampler produces subtly wrong output samples
// near the edges of a finite chunk because the kernel reaches for samples
// that don't exist beyond the chunk boundary.  The OversizeBuffer pattern
// solves this by:
//   1. Padding each frame with context samples from adjacent frames
//   2. Resampling the oversized frame (which has valid data at the edges)
//   3. Extracting only the central "good" portion, discarding edge artifacts
//
// The context buffer carries the tail of the previous frame into the next
// call, providing the resampler with real audio data at the boundaries.
//
class OversizeBuffer {
    /**
     * @param {number} frameLengthSamples   expected frame size (input side)
     * @param {number} trailingBufferSamples  context samples to prepend (from previous frames)
     * @param {number} leadingBufferSamples   context samples appended (lookahead)
     * @param {number} trailingSlice  samples to trim from start of resampled output
     * @param {number} leadingSlice   samples to trim from end of resampled output
     */
    constructor(frameLengthSamples, trailingBufferSamples, leadingBufferSamples, trailingSlice, leadingSlice) {
        this.frameLengthSamples    = frameLengthSamples;
        this.trailingBufferSamples = trailingBufferSamples;
        this.leadingBufferSamples  = leadingBufferSamples;
        this.trailingSlice         = trailingSlice;
        this.leadingSlice          = leadingSlice;
        this.totalBufferSize       = trailingBufferSamples + leadingBufferSamples;
        this.contextBuffer         = new Float32Array(this.totalBufferSize);
        this.contextBuffer.fill(0);
    }

    /**
     * Prepend context from previous frames, append the current frame,
     * and update the internal context buffer for the next iteration.
     *
     * @param {Float32Array} inputFrame
     * @returns {Float32Array} oversized frame (context + inputFrame)
     */
    addFrame(inputFrame) {
        const oversizedFrame = new Float32Array(this.totalBufferSize + inputFrame.length);
        oversizedFrame.set(this.contextBuffer, 0);
        oversizedFrame.set(inputFrame, this.totalBufferSize);

        // Update context: last totalBufferSize samples of the oversized frame
        this.contextBuffer.set(
            oversizedFrame.subarray(oversizedFrame.length - this.totalBufferSize)
        );
        return oversizedFrame;
    }

    /**
     * Extract the central "good" portion of a resampled oversized frame,
     * trimming edge-contaminated samples from both ends.
     *
     * @param {Float32Array} inputSamples  resampled oversized frame
     * @returns {Float32Array}
     */
    goodFrame(inputSamples) {
        return inputSamples.subarray(
            this.trailingSlice,
            inputSamples.length - this.leadingSlice
        );
    }

    /** Reset context buffer (e.g. on sample-rate change or disconnect). */
    reset() {
        this.contextBuffer.fill(0);
    }
}

// ── Lanczos resampler ──────────────────────────────────────────────────────────
//
// Stateless Lanczos (a=3) windowed-sinc resampler, copied from the known-good
// audio_mixer_processor.js reference.  Edge artifacts are handled by the
// OversizeBuffer pattern above — the resampler itself doesn't need state.
//
/**
 * Resample `input` from rate `from` to rate `to` using Lanczos interpolation.
 * @param {Float32Array} input
 * @param {number} from  source sample rate
 * @param {number} to    target sample rate
 * @returns {Float32Array}
 */
function lanczosResample(input, from, to) {
    if (from === to) return input;

    const ratio     = from / to;
    const newLength = Math.round(input.length / ratio);
    const output    = new Float32Array(newLength);
    const a         = 3;   // Lanczos kernel lobes
    const PI        = Math.PI;

    const sinc = (x) => {
        if (x === 0) return 1;
        return Math.sin(PI * x) / (PI * x);
    };
    const lanczos = (x) => {
        if (x === 0) return 1;
        if (x > -a && x < a) return sinc(x) * sinc(x / a);
        return 0;
    };

    for (let i = 0; i < newLength; i++) {
        const inputIndex = i * ratio;
        let sum       = 0;
        let weightSum = 0;
        const start = Math.floor(inputIndex - a + 1);
        const end   = Math.ceil(inputIndex + a);

        for (let j = start; j < end; j++) {
            if (j >= 0 && j < input.length) {
                const x      = inputIndex - j;
                const weight = lanczos(x);
                sum       += input[j] * weight;
                weightSum += weight;
            }
        }
        output[i] = weightSum === 0 ? 0 : sum / weightSum;
    }
    return output;
}

/**
 * Create a pair of OversizeBuffer instances sized for the given rates.
 * Context sizes are chosen to exceed the Lanczos a=3 kernel radius on
 * both sides of the rate conversion, matching the reference implementation's
 * approach of ~10 context samples on the low-rate side and the scaled
 * equivalent on the high-rate side.
 *
 * @param {number} inputRate  e.g. 12000
 * @returns {{ downsampleOSB: OversizeBuffer, upsampleOSB: OversizeBuffer }}
 */
function rmNoise_createOversizeBuffers(inputRate) {
    const ratio = inputRate / RM_RATE;   // e.g. 1.5 for 12 kHz, 6.0 for 48 kHz
    const accumTarget = Math.round(RM_FRAME * ratio);  // frame size at inputRate

    // Context samples on the low-rate (8 kHz) side — 10 is generous for a=3
    const ctx8k = 10;
    // Scaled equivalent on the high-rate side
    const ctxHi = Math.ceil(ctx8k * ratio);

    // Downsample: inputRate → 8 kHz
    // Context at inputRate, trim at 8 kHz
    const downsampleOSB = new OversizeBuffer(
        accumTarget,    // frame length at inputRate
        ctxHi, ctxHi,   // trailing + leading context at inputRate
        ctx8k, ctx8k     // trim from resampled 8 kHz output
    );

    // Upsample: 8 kHz → inputRate
    // Context at 8 kHz, trim at inputRate
    const upsampleOSB = new OversizeBuffer(
        RM_FRAME,        // frame length at 8 kHz (384)
        ctx8k, ctx8k,    // trailing + leading context at 8 kHz
        ctxHi, ctxHi     // trim from resampled inputRate output
    );

    return { downsampleOSB, upsampleOSB };
}

// LPF group delay = (numTaps-1)/2 = (1001-1)/2 = 500 samples at 12 kHz = 41.7 ms.
// Used to pre-delay the raw orig so it aligns with the LPF-processed denoised output.
const RM_LPF_GROUP_DELAY = 500;


const rmNoise = {
    enabled:          false,
    bypass:           false,   // legacy — kept for compatibility but superseded by mixRatio
    ready:            false,
    connecting:       false,
    mixRatio:         1.0,     // 0.0 = 100% original, 1.0 = 100% denoised

    // WebRTC / WebSocket
    pc:               null,    // RTCPeerConnection
    dc:               null,    // RTCDataChannel
    ws:               null,    // WebSocket (signalling)

    // Protocol
    frameNum:         BigInt(0),
    inputRate:        12000,   // current server sample rate (updated per packet)
    filterNumber:     1,
    availableFilters: [],

    // Jitter buffer (stores Float32Array frames at 8 kHz).
    // Each frame is 384 samples = 48 ms.  Keep at most ~1 s (20 frames) here;
    // accumOut is separately capped at ~500 ms so the total pipeline latency
    // stays bounded.  The old value of 256 (≈12 s) allowed the buffer to grow
    // enormous during network bursts, causing loud pops when frames were
    // eventually dropped.
    jitterBuf:        [],
    jitterMax:        20,

    // Accumulators
    accumIn:          new Float32Array(0),   // input samples at inputRate (LPF-filtered, for server send path)
    accumOut:         new Float32Array(0),   // denoised 8 kHz samples (intermediate)

    // [HB9VQQ] Phase 4b: raw audio delay line for time-aligned orig in blend.
    // Pre-filled with RM_LPF_GROUP_DELAY zeros so that slicing in lockstep with
    // accumIn gives raw audio that corresponds to the same time window as the
    // LPF-processed audio sent to the server (whose output is also delayed by
    // RM_LPF_GROUP_DELAY samples due to the causal FIR group delay).
    // Using raw audio (not LPF-filtered) as orig avoids the metallic comb-filter
    // artifact that arises from blending two differently-shaped LPF-limited signals.

    // [HB9VQQ] Phase 4b: frame-number keyed original store for echo-free blend.
    // Key = Number(frameNum), value = Float32Array at inputRate (one accumTarget chunk).
    // Blend is performed in dc.onmessage when the denoised frame arrives — at that
    // moment both original and denoised correspond to the same wire-protocol frame,
    // so mixing them at any ratio produces no echo regardless of RTT.
    origFrameMap:     new Map(),
    origFrameMapMax:  300,    // evict oldest when this many unmatched entries build up

    // AI lookahead delay line for JS blend path (HTTP — no AudioWorklet).
    // Same compensation as ORIG_DELAY_48K in the worklet but at inputRate (12kHz).
    // 300 samples @ 8kHz × (12000/8000) = 450 samples @ 12kHz = 37.5ms.
    origBlendDelay:   null,   // Float32Array delay line, lazy-init in rmNoise_blendFrame

    blendedBuf:       new Float32Array(0),

    // Pre-buffering: don't output denoised audio until we have a reserve built up.
    // At 8 kHz, RM_FRAME=384 samples = 48 ms per frame.
    // We wait for 5 frames (≈240 ms) before starting playback so the pipeline
    // stays ahead of the network round-trip.
    primed:           false,
    primeFrames:      2,       // number of 8 kHz frames to accumulate before starting
                               // (jitter buffer stays near 0 in practice; 5 was too
                               // aggressive and caused long silence on initial connect)

    // Latency tracking
    sendTimes:        new Map(),             // BigInt frameNum → performance.now()
    lastLatencyMs:    0,
    lastStatsUpdate:  0,

    // Stats poll interval
    statsInterval:    null,

    // OversizeBuffer instances — pad each frame with context from adjacent
    // frames before resampling, then extract the central "good" portion.
    // This eliminates edge artifacts from the Lanczos windowed-sinc kernel.
    // Initialised lazily via rmNoise_createOversizeBuffers() on first use
    // or rate change.
    downsampleOSB:    null,   // send path  (inputRate → 8 kHz)
    upsampleOSB:      null,   // receive path (8 kHz → inputRate)

    // [HB9VQQ] Phase 4b: AudioWorklet mixer node.
    // When non-null, rmNoise_process() returns silence and the worklet
    // handles all audio output via its AudioNode connected to player.gainNode.
    workletNode:      null,
    workletLoading:   false,   // synchronous re-entry guard for ensureWorklet

    // 2.8 kHz send-path LPF — keeps the AI model in its trained voice-bandwidth
    // domain.  Coefficients and state are initialised lazily in rmNoise_process()
    // and reset on sample-rate change.
};

// Expose globally so app.js can call rmNoise_process()
window.rmNoiseBridge = rmNoise;

// ── Wire-protocol helpers ──────────────────────────────────────────────────────

/**
 * Pack a 20-byte header + int16 PCM frame.
 * Mirrors pack_frame() in rmnoise_denoise.py
 */
function rmNoise_packFrame(frameNum, tsMs, pcm8k_i16, scale) {
    const headerBytes = 20;
    const pcmBytes    = pcm8k_i16.length * 2;
    const buf         = new ArrayBuffer(headerBytes + pcmBytes);
    const view        = new DataView(buf);

    view.setBigUint64(0,  BigInt(frameNum), true);   // uint64 LE
    view.setBigUint64(8,  BigInt(tsMs),     true);   // uint64 LE
    view.setUint32(16,    scale,            true);   // uint32 LE

    const pcmView = new Int16Array(buf, headerBytes);
    pcmView.set(pcm8k_i16);
    return buf;
}

/**
 * Unpack a server frame.
 * Mirrors unpack_frame() in rmnoise_denoise.py
 * Returns { frameNum (BigInt), tsMs (BigInt), scale (number), pcm (Int16Array) }
 */
function rmNoise_unpackFrame(data) {
    const view    = new DataView(data);
    const frameNum = view.getBigUint64(0,  true);
    const tsMs     = view.getBigUint64(8,  true);
    const scale    = view.getUint32(16,    true);
    const pcm      = new Int16Array(data, 20);
    return { frameNum, tsMs, scale, pcm };
}

// ── Audio processing ───────────────────────────────────────────────────────────

// ── Send-path LPF helpers ──────────────────────────────────────────────────────
//
// Design and apply a windowed-sinc FIR low-pass filter.  Logic mirrors
// NoiseBlanker.designFIRLowpass() and NoiseBlanker.applyAudioFilter() in
// noise-blanker.js, adapted as standalone functions so rmnoise.js has no
// dependency on the NoiseBlanker class.

/**
 * Design a windowed-sinc (Hamming) FIR low-pass filter.
 * @param {number} cutoffHz   -3 dB cutoff frequency in Hz
 * @param {number} sampleRate input sample rate in Hz
 * @returns {Float32Array}    FIR coefficients (odd length, normalised to unity DC gain)
 */
function rmNoise_designLPF(cutoffHz, sampleRate) {
    let numTaps = Math.min(Math.floor(sampleRate / 10), 1001);
    if (numTaps % 2 === 0) numTaps += 1;   // must be odd

    const coeffs = new Float32Array(numTaps);
    const fc     = cutoffHz / sampleRate;  // normalised cutoff
    const M      = (numTaps - 1) / 2;

    for (let n = 0; n < numTaps; n++) {
        const x = n - M;
        // Windowed sinc
        const h = (x === 0) ? 2 * fc
                             : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        // Hamming window
        const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (numTaps - 1));
        coeffs[n] = h * w;
    }

    // Normalise to unity DC gain
    let sum = 0;
    for (let i = 0; i < numTaps; i++) sum += coeffs[i];
    for (let i = 0; i < numTaps; i++) coeffs[i] /= sum;

    return coeffs;
}

/**
 * Apply a stateful FIR filter in-place, preserving state across calls.
 * @param {Float32Array} input   samples to filter (read-only)
 * @param {Float32Array} coeffs  FIR coefficients
 * @param {Float32Array} state   delay line (length = coeffs.length - 1), mutated in place
 * @returns {Float32Array}       filtered copy of input
 */
function rmNoise_applyLPF(input, coeffs, state) {
    const numTaps    = coeffs.length;
    const numSamples = input.length;
    const output     = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
        // Shift delay line
        for (let j = numTaps - 2; j > 0; j--) {
            state[j] = state[j - 1];
        }
        state[0] = input[i];

        // Convolve
        let y = coeffs[0] * input[i];
        for (let j = 1; j < numTaps; j++) {
            y += coeffs[j] * state[j - 1];
        }
        output[i] = y;
    }
    return output;
}

/**
 * Process a mono Float32Array through the RMNoise bridge.
 * Mirrors RMNoiseBridge.process() in rmnoise_window.py
 *
 * @param {Float32Array} audioFloat  mono samples at inputRate
 * @param {number}       sampleRate  current server sample rate
 * @returns {Float32Array|null}  denoised samples at sampleRate, or null if not ready
 */
function rmNoise_process(audioFloat, sampleRate) {
    if (!rmNoise.ready || !rmNoise.dc || rmNoise.dc.readyState !== 'open') {
        return null;   // not connected — caller uses original audio
    }

    // [HB9VQQ] Phase 4b: lazy AudioWorklet init — fires once after audio is flowing.
    // workletLoading is set synchronously to prevent re-entry across async gap.
    // audioWorklet existence check guards against webkitAudioContext fallback or
    // any other context type that doesn't support AudioWorklet.
    if (!rmNoise.workletNode && !rmNoise.workletLoading
            && window.rmNoiseAudioCtx
            && window.rmNoiseAudioCtx.audioWorklet
            && window.rmNoiseAudioCtx.state === 'running'
            && window.rmNoise_ensureWorklet) {
        rmNoise.workletLoading = true;
        window.rmNoise_ensureWorklet(window.rmNoiseAudioCtx);   // async, fire-and-forget
    }

    // Update rate if changed — flush all state so stale context doesn't bleed in
    if (rmNoise.inputRate !== sampleRate || !rmNoise.downsampleOSB) {
        rmNoise.inputRate   = sampleRate;
        rmNoise.accumIn     = new Float32Array(0);
        rmNoise.lpfCoeffs   = null;
        rmNoise.lpfState    = null;
        rmNoise.lpfRate     = 0;
        rmNoise.accumOut    = new Float32Array(0);
        rmNoise.blendedBuf  = new Float32Array(0);
        rmNoise.origFrameMap.clear();
    rmNoise.origBlendDelay = null;
        rmNoise.primed      = false;
        const bufs = rmNoise_createOversizeBuffers(sampleRate);
        rmNoise.downsampleOSB = bufs.downsampleOSB;
        rmNoise.upsampleOSB   = bufs.upsampleOSB;
    }

    const nIn        = audioFloat.length;
    const accumTarget = Math.round(RM_FRAME * sampleRate / RM_RATE);

    // ── Send-path LPF: anti-alias before 12kHz→8kHz downsampling ─────────────
    // ka9q-web SSB demodulator outputs 12kHz but voice content is only 300-2800Hz.
    // Above 2800Hz is SDR noise.  Without a pre-filter, that noise aliases into
    // the 2-4kHz voice band during 12kHz→8kHz downsampling, degrading AI quality.
    // rmnoise.com applies a zero-phase elliptical LPF at ~4kHz before downsampling.
    // We apply a causal FIR at 3kHz — removes aliasing noise, preserves voice band.
    // This filter is applied to the SEND PATH ONLY — chunk (for blend orig) stays raw.
    if (!rmNoise.lpfCoeffs || rmNoise.lpfRate !== sampleRate) {
        rmNoise.lpfRate   = sampleRate;
        rmNoise.lpfCoeffs = rmNoise_designLPF(3000, sampleRate);
        rmNoise.lpfState  = new Float32Array(rmNoise.lpfCoeffs.length - 1);
    }
    const sendAudio = rmNoise_applyLPF(audioFloat, rmNoise.lpfCoeffs, rmNoise.lpfState);

    // accumIn holds LPF-filtered audio for the server send path.
    // Raw audioFloat is stored separately as orig for the blend (full bandwidth).
    const newAccumIn = new Float32Array(rmNoise.accumIn.length + nIn);
    newAccumIn.set(rmNoise.accumIn);
    newAccumIn.set(sendAudio, rmNoise.accumIn.length);
    rmNoise.accumIn = newAccumIn;

    // Used as blend orig so partial mix has full 0-6kHz bandwidth.

    while (rmNoise.accumIn.length >= accumTarget) {
        const chunk = rmNoise.accumIn.slice(0, accumTarget);
        rmNoise.accumIn = rmNoise.accumIn.slice(accumTarget);

        // Raw chunk (unfiltered) — used as blend orig

        try {
            // Downsample LPF-filtered audio to 8 kHz for server
            const oversizedChunk = rmNoise.downsampleOSB.addFrame(chunk);
            const oversizedDown  = lanczosResample(oversizedChunk, sampleRate, RM_RATE);
            const pcm8k_good     = rmNoise.downsampleOSB.goodFrame(oversizedDown);

            // Trim/pad to exactly RM_FRAME samples
            let frame8k;
            if (pcm8k_good.length >= RM_FRAME) {
                frame8k = pcm8k_good.slice(0, RM_FRAME);
            } else {
                frame8k = new Float32Array(RM_FRAME);
                frame8k.set(pcm8k_good);
            }

            // Compute audioScale and convert to int16
            let maxAbs = 0;
            for (let i = 0; i < frame8k.length; i++) {
                const a = Math.abs(frame8k[i]);
                if (a > maxAbs) maxAbs = a;
            }
            const scale = maxAbs > 1e-9 ? Math.min(Math.floor(32767.0 / maxAbs), 4294967295) : 1;

            const pcm8k_i16 = new Int16Array(RM_FRAME);
            for (let i = 0; i < RM_FRAME; i++) {
                pcm8k_i16[i] = Math.max(-32768, Math.min(32767, Math.round(frame8k[i] * scale)));
            }

            const tsMs    = BigInt(Date.now());
            const frameNum = rmNoise.frameNum;
            const packed  = rmNoise_packFrame(frameNum, tsMs, pcm8k_i16, scale);

            rmNoise.sendTimes.set(frameNum, performance.now());
            if (rmNoise.sendTimes.size > 300) {
                // Evict oldest
                const oldest = rmNoise.sendTimes.keys().next().value;
                rmNoise.sendTimes.delete(oldest);
            }

            if (rmNoise.dc && rmNoise.dc.readyState === 'open') {
                rmNoise.dc.send(packed);
            }

            // [HB9VQQ] Phase 4b: store LPF-filtered chunk as blend orig.
            // rmnoise.com stores filtFiltEllipticalFilter.process(frame48k) as orig —
            // the SAME filtered audio sent to the server. Both sides of the blend
            // use the same filtered signal. We do the same: chunk (LPF-filtered)
            // is both sent to the server AND stored as orig.
            rmNoise.origFrameMap.set(Number(frameNum), chunk.slice());
            if (rmNoise.origFrameMap.size > rmNoise.origFrameMapMax) {
                rmNoise.origFrameMap.delete(rmNoise.origFrameMap.keys().next().value);
            }

            // [HB9VQQ] Phase 4b: post LPF-filtered orig frame to AudioWorklet
            if (rmNoise.workletNode) {
                const _wOrig = chunk.slice();
                rmNoise.workletNode.port.postMessage(
                    { type: 'orig', frameNum: Number(frameNum), samples: _wOrig },
                    [ _wOrig.buffer ]
                );
            }

            rmNoise.frameNum = frameNum + BigInt(1);
        } catch (e) {
            console.error('[RMNoise] Send error:', e);
        }
    }

    // ── Receive path: drain blendedBuf (pre-blended at inputRate) ─────────────
    // [HB9VQQ] Phase 4b: blend is performed in dc.onmessage keyed by frameNum,
    // so original and denoised are always from the same wire frame — echo-free.
    // blendedBuf accumulates pre-blended Float32Array chunks at inputRate.
    if (rmNoise.workletNode) {
        return new Float32Array(audioFloat.length);   // silence — worklet handles playback
    }

    // Priming: wait until blendedBuf has enough data to absorb RTT jitter.
    // At inputRate=12000, primeFrames*accumTarget samples covers the initial RTT.
    const primeThreshold = rmNoise.primeFrames * Math.round(RM_FRAME * sampleRate / RM_RATE);
    if (!rmNoise.primed) {
        if (rmNoise.blendedBuf.length >= primeThreshold) {
            rmNoise.primed = true;
            rmNoise_log(`Buffer primed (${rmNoise.blendedBuf.length} samples @ ${sampleRate} Hz) — denoising active`);
        } else {
            return new Float32Array(audioFloat.length);   // still filling — return silence
        }
    }

    if (rmNoise.blendedBuf.length >= nIn) {
        const out = rmNoise.blendedBuf.slice(0, nIn);
        rmNoise.blendedBuf = rmNoise.blendedBuf.slice(nIn);
        return out;
    }

    // blendedBuf ran dry (network hiccup) — return silence
    return new Float32Array(audioFloat.length);
}

// ── dc.onmessage blend helper ──────────────────────────────────────────────────

/**
 * Called from dc.onmessage when a denoised 8 kHz frame arrives.
 * Looks up the original frame in origFrameMap (keyed by frameNum),
 * upsamples denoised 8 kHz → inputRate, blends, appends to blendedBuf.
 *
 * @param {BigInt}      frameNum
 * @param {Float32Array} pcm8k_f32  denoised at 8 kHz
 */
function rmNoise_blendFrame(frameNum, pcm8k_f32) {
    const mix = rmNoise.mixRatio != null ? rmNoise.mixRatio : 1.0;
    const rate = rmNoise.inputRate;
    const key  = Number(frameNum);

    // Upsample denoised 8 kHz → inputRate using direct stateless Lanczos resampling.
    const denoised = lanczosResample(pcm8k_f32, RM_RATE, rate);
    const nFrame   = denoised.length;   // e.g. 576 at 12 kHz

    let blended;

    if (mix >= 1.0) {
        blended = new Float32Array(nFrame);
        blended.set(denoised);
    } else {
        const origRaw = rmNoise.origFrameMap.get(key);
        rmNoise.origFrameMap.delete(key);

        if (origRaw) {
            // Band-limit orig to 0–4kHz (round-trip downsample+upsample).
            const origDown = lanczosResample(origRaw, rate, RM_RATE);
            const origBL   = lanczosResample(origDown, RM_RATE, rate);

            // Apply AI lookahead delay: 300 samples @ 8kHz = 450 samples @ 12kHz = 37.5ms.
            // The AI model has a built-in 300-sample lookahead @ 8kHz — without this delay
            // orig is 37.5ms ahead of denoised, producing audible echo at that delay.
            const delaySamples = Math.round(300 * rate / RM_RATE);  // 450 @ 12kHz
            if (!rmNoise.origBlendDelay || rmNoise.origBlendDelay.length !== delaySamples) {
                rmNoise.origBlendDelay = new Float32Array(delaySamples);
            }
            // Shift delay line and produce delayed output
            const origDelayed = new Float32Array(origBL.length);
            const dLen = rmNoise.origBlendDelay.length;
            for (let i = 0; i < origBL.length; i++) {
                origDelayed[i] = i < dLen ? rmNoise.origBlendDelay[i] : origBL[i - dLen];
            }
            // Update delay line with tail of origBL
            const tail = origBL.slice(Math.max(0, origBL.length - dLen));
            if (tail.length >= dLen) {
                rmNoise.origBlendDelay.set(tail.slice(tail.length - dLen));
            } else {
                rmNoise.origBlendDelay.copyWithin(0, tail.length);
                rmNoise.origBlendDelay.set(tail, dLen - tail.length);
            }

            const orig = origDelayed;
            const len  = Math.min(nFrame, orig.length);

            if (mix <= 0.0) {
                blended = orig.slice(0, len);
            } else {
                blended = new Float32Array(len);
                for (let i = 0; i < len; i++) {
                    blended[i] = denoised[i] * mix + orig[i] * (1.0 - mix);
                }
            }
        } else {
            // Original evicted or missing — fall back to denoised
            blended = new Float32Array(nFrame);
            blended.set(denoised);
        }
    }

    // Cap blendedBuf to ~1 s at inputRate to prevent unbounded growth
    const blendedMax = rate;
    if (rmNoise.blendedBuf.length + blended.length > blendedMax) {
        rmNoise.blendedBuf = rmNoise.blendedBuf.slice(rmNoise.blendedBuf.length + blended.length - blendedMax);
    }

    const merged = new Float32Array(rmNoise.blendedBuf.length + blended.length);
    merged.set(rmNoise.blendedBuf);
    merged.set(blended, rmNoise.blendedBuf.length);
    rmNoise.blendedBuf = merged;
}

// ── Connection ─────────────────────────────────────────────────────────────────

// ── AudioWorklet setup ─────────────────────────────────────────────────────────

/**
 * Load ka9q-rmnoise-worklet.js into the given AudioContext and create an
 * AudioWorkletNode connected to window.player.gainNode.
 *
 * Called once per connect (idempotent — skips if workletNode already exists).
 * On failure (e.g. insecure context, old browser), logs a warning and leaves
 * rmNoise.workletNode = null so rmNoise_process() falls back to the JS path.
 *
 * @param {AudioContext} audioCtx
 */
// ── HB9VQQ BEGIN: rmnoise AudioWorklet setup ──
async function rmNoise_ensureWorklet(audioCtx) {
    if (rmNoise.workletNode) return;   // already loaded

    try {
        await audioCtx.audioWorklet.addModule('ka9q-rmnoise-worklet.js');
        const node = new AudioWorkletNode(audioCtx, 'rmnoise-processor', {
            numberOfInputs:     0,
            numberOfOutputs:    1,
            outputChannelCount: [1],
        });
        // Connect to gainNode so volume and pan controls apply to worklet output
        if (window.rmNoiseGainNode) {
            node.connect(window.rmNoiseGainNode);
        } else {
            node.connect(audioCtx.destination);
        }
        // Seed current mix ratio (may have been set before connection)
        node.port.postMessage({ type: 'mix', value: rmNoise.mixRatio });

        rmNoise.workletNode    = node;
        rmNoise.workletLoading = false;
        rmNoise_log('AudioWorklet mixer loaded ✓');
    } catch (e) {
        rmNoise.workletLoading = false;   // allow retry if context changes
        console.warn('[RMNoise] AudioWorklet unavailable — falling back to JS blend:', e);
        rmNoise_log('AudioWorklet unavailable — using JS blend (mix slider limited)');
        // workletNode stays null → rmNoise_process JS path is used
    }
}
// ── HB9VQQ END: rmnoise AudioWorklet setup ──

async function rmNoise_connect(username, password, filterNumber) {
    if (rmNoise.connecting || rmNoise.ready) return;
    rmNoise.connecting = true;
    rmNoise.filterNumber = filterNumber || 1;

    // [HB9VQQ] Phase 4b: AudioWorklet is initialised lazily from rmNoise_process()
    // on the first call after audio is flowing, so the AudioContext is guaranteed
    // to be in running state (audioWorklet defined) at that point.

    rmNoise_setStatus('Connecting…', 'orange');
    rmNoise_log(`Connecting to RMNoise as '${username}' (filter ${rmNoise.filterNumber})…`);
    rmNoise_updateButton();

    try {
        // ── Single proxy call: login + webrtc_token + turn_creds in one request ─
        const credsText = await fetch('/api/rmnoise/credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        }).then(r => r.text());

        let credsData;
        try { credsData = JSON.parse(credsText); } catch {
            throw new Error(`Proxy error: unexpected non-JSON response`);
        }
        if (!credsData.ok) throw new Error(credsData.error || 'Authentication failed');

        const webrtcToken = credsData.webrtc_token;
        const turnData    = credsData.turn_creds;

        if (!webrtcToken?.success || !webrtcToken?.token) {
            throw new Error('Failed to get WebRTC token from proxy response');
        }
        if (!turnData?.success) {
            throw new Error('Failed to get TURN credentials from proxy response');
        }

        rmNoise_log('Credentials received');

        const iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            {
                urls:       turnData.uris || [],
                username:   turnData.username,
                credential: turnData.password,
            },
        ];

        // ── WebSocket signalling ───────────────────────────────────────────────
        await rmNoise_connectWS(webrtcToken.token, iceServers);

    } catch (e) {
        console.error('[RMNoise] Connection error:', e);
        rmNoise_log(`Connection failed: ${e.message}`);
        rmNoise_setStatus('Failed', 'red');
        rmNoise.connecting = false;
        rmNoise.enabled    = false;
        rmNoise_updateButton();
        rmNoise_syncCheckbox();
    }
}

async function rmNoise_connectWS(token, iceServers) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(RM_SERVER);
        rmNoise.ws = ws;

        ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'auth', token }));
        };

        ws.onmessage = async (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }

            switch (msg.type) {
                case 'auth_ok':
                    rmNoise_log('WebSocket authenticated');
                    ws.send(JSON.stringify({
                        type: 'ai_filter_selection',
                        filterNumber: rmNoise.filterNumber,
                    }));
                    // Set up WebRTC
                    try {
                        await rmNoise_setupWebRTC(ws, iceServers);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                    break;

                case 'answer':
                    if (rmNoise.pc) {
                        const ad = msg.answer || msg;
                        await rmNoise.pc.setRemoteDescription(
                            new RTCSessionDescription({ type: 'answer', sdp: ad.sdp })
                        );
                        rmNoise_log('WebRTC answer received');
                    }
                    break;

                case 'ice-candidate':
                    if (rmNoise.pc && msg.candidate && msg.candidate.candidate) {
                        try {
                            await rmNoise.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                        } catch (e) {
                            console.warn('[RMNoise] ICE candidate error:', e);
                        }
                    }
                    break;

                case 'ai_filters_list':
                    rmNoise.availableFilters = msg.filters || [];
                    rmNoise_log(`Available AI filters: ${rmNoise.availableFilters.length}`);
                    rmNoise_populateFilterList();
                    break;

                case 'entered_standby':
                    rmNoise_log(`Server standby: ${msg.reason || ''}`);
                    break;

                case 'left_standby':
                    rmNoise_log('Server left standby');
                    break;

                default:
                    break;
            }
        };

        ws.onerror = (e) => {
            reject(new Error('WebSocket error'));
        };

        ws.onclose = () => {
            if (rmNoise.ready) {
                rmNoise_log('WebSocket closed');
                rmNoise_handleDisconnect();
            }
        };
    });
}

async function rmNoise_setupWebRTC(ws, iceServers) {
    rmNoise_log('Setting up WebRTC…');

    const pc = new RTCPeerConnection({ iceServers });
    rmNoise.pc = pc;

    const dc = pc.createDataChannel('audio', { ordered: false, maxRetransmits: 0 });
    dc.binaryType = 'arraybuffer';   // must be set before onmessage fires
    rmNoise.dc = dc;

    dc.onopen = () => {
        rmNoise_log('Data channel opened – denoising active');
        rmNoise.ready      = true;
        rmNoise.connecting = false;
        rmNoise_setStatus('Connected ✓', 'green');
        rmNoise_updateButton();
        rmNoise_syncCheckbox();
        rmNoise_startStatsInterval();
    };

    dc.onclose = () => {
        if (rmNoise.ready) {
            rmNoise_log('Data channel closed');
            rmNoise_handleDisconnect();
        }
    };

    dc.onerror = (e) => {
        console.error('[RMNoise] DataChannel error:', e);
    };

    dc.onmessage = (ev) => {
        // Discard frames that arrived within 300 ms of a sample-rate change.
        // They were sent at the old rate and will corrupt the new pipeline.
        if (rmNoise.rateChangedAt && performance.now() - rmNoise.rateChangedAt < 300) {
            return;
        }
        try {
            const { frameNum, scale, pcm } = rmNoise_unpackFrame(ev.data);

            // Undo audioScale normalisation → float32 in [-1, 1]
            const s = scale > 0 ? scale : 32767;
            const pcm8k_f32 = new Float32Array(pcm.length);
            for (let i = 0; i < pcm.length; i++) {
                pcm8k_f32[i] = pcm[i] / s;
            }

            // Measure latency
            if (rmNoise.sendTimes.has(frameNum)) {
                const lat = performance.now() - rmNoise.sendTimes.get(frameNum);
                rmNoise.sendTimes.delete(frameNum);
                rmNoise.lastLatencyMs = lat;
            }

            // [HB9VQQ] Phase 4b: blend this denoised frame with its matching original
            // (from origFrameMap) and append to blendedBuf.  Frame-number keyed —
            // original and denoised are the same wire frame → echo-free at any mix.
            if (rmNoise.upsampleOSB) {
                rmNoise_blendFrame(frameNum, pcm8k_f32);
            } else {
                // upsampleOSB not yet initialised (rate not yet known) — push to
                // legacy jitterBuf as fallback so priming still works
                if (rmNoise.jitterBuf.length >= rmNoise.jitterMax) rmNoise.jitterBuf.shift();
                rmNoise.jitterBuf.push(pcm8k_f32);
            }

            // [HB9VQQ] Phase 4b: post denoised frame to AudioWorklet at native 8kHz.
            // Do NOT upsample to 12kHz here.  lanczosResample(8kHz→12kHz) introduces
            // ~2 samples of group delay at 12kHz, causing a comb-filter notch at 3kHz
            // when mixed against orig (which has zero intermediate delay).
            // The worklet upsamples both orig (12kHz→48kHz) and den (8kHz→48kHz)
            // independently — the resulting group delay mismatch is only ~20µs,
            // placing any comb notch at 24kHz (inaudible).
            if (rmNoise.workletNode) {
                const _wDen = new Float32Array(pcm8k_f32.length);
                _wDen.set(pcm8k_f32);   // transferable copy
                rmNoise.workletNode.port.postMessage(
                    { type: 'den', frameNum: Number(frameNum), samples: _wDen },
                    [ _wDen.buffer ]
                );
            }

        } catch (e) {
            console.error('[RMNoise] Server audio error:', e);
        }
    };

    pc.onicecandidate = (ev) => {
        if (ev.candidate) {
            ws.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: {
                    candidate:     ev.candidate.candidate,
                    sdpMid:        ev.candidate.sdpMid,
                    sdpMLineIndex: ev.candidate.sdpMLineIndex,
                },
            }));
        }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({
        type:  'offer',
        offer: { type: 'offer', sdp: pc.localDescription.sdp },
    }));
    rmNoise_log('WebRTC offer sent');
}

function rmNoise_handleDisconnect() {
    rmNoise.ready      = false;
    rmNoise.connecting = false;
    if (rmNoise.enabled) {
        rmNoise_setStatus('Disconnected', 'grey');
    }
    rmNoise_clearStatusLabel();
    rmNoise_updateButton();
    rmNoise_syncCheckbox();
    rmNoise_stopStatsInterval();
}

async function rmNoise_disconnect() {
    rmNoise_log('Stopping RMNoise bridge…');
    rmNoise_stopStatsInterval();

    if (rmNoise.dc) {
        try { rmNoise.dc.close(); } catch {}
        rmNoise.dc = null;
    }
    if (rmNoise.pc) {
        try { rmNoise.pc.close(); } catch {}
        rmNoise.pc = null;
    }
    if (rmNoise.ws) {
        try { rmNoise.ws.close(); } catch {}
        rmNoise.ws = null;
    }

    rmNoise.ready      = false;
    rmNoise.connecting = false;
    rmNoise.primed     = false;
    rmNoise.accumIn    = new Float32Array(0);
    rmNoise.lpfCoeffs  = null;
    rmNoise.lpfState   = null;
    rmNoise.lpfRate    = 0;
    rmNoise.accumOut   = new Float32Array(0);
    rmNoise.blendedBuf = new Float32Array(0);
    rmNoise.origFrameMap.clear();
    rmNoise.origBlendDelay = null;
    rmNoise.jitterBuf  = [];
    rmNoise.sendTimes.clear();
    rmNoise.frameNum   = BigInt(0);
    rmNoise.downsampleOSB = null;
    rmNoise.upsampleOSB   = null;

    // [HB9VQQ] Phase 4b: flush AudioWorklet queues on disconnect
    if (rmNoise.workletNode) {
        rmNoise.workletNode.port.postMessage({ type: 'reset' });
    }
}

// ── Toggle functions ───────────────────────────────────────────────────────────

async function toggleRMNoise() {
    if (rmNoise.enabled) {
        // Disable
        rmNoise.enabled = false;
        rmNoise.bypass  = false;
        await rmNoise_disconnect();
        rmNoise_setStatus('Disconnected', 'grey');
        rmNoise_clearStatusLabel();
        rmNoise_updateButton();
        rmNoise_syncCheckbox();
        rmNoise_log('RMNoise denoising disabled');
    } else {
        // Enable
        const username = localStorage.getItem('rmnoise_username') || '';
        const password = localStorage.getItem('rmnoise_password') || '';
        if (!username || !password) {
            openRMNoiseModal();
            return;
        }
        rmNoise.enabled = true;
        rmNoise_syncCheckbox();
        await rmNoise_connect(username, password, rmNoise.filterNumber);
    }
}

function toggleRMNoiseQuick() {
    const hasCreds = localStorage.getItem('rmnoise_username') &&
                     localStorage.getItem('rmnoise_password');
    if (!hasCreds) {
        openRMNoiseModal();
        return;
    }
    toggleRMNoise();
}

function toggleRMNoiseBypass() {
    rmNoise.bypass = !rmNoise.bypass;
    const btn = document.getElementById('rmn-bypass-modal-btn');
    if (btn) {
        btn.textContent  = rmNoise.bypass ? '● Original' : 'Original';
        btn.style.color  = rmNoise.bypass ? '#ff6b6b' : '';
    }
    // [HB9VQQ] Phase 4b: tell worklet to output silence when bypassed.
    // pcm-player plays raw audio through gainNode when bypass=true.
    // Worklet stays connected — no connect/disconnect to avoid stale gainNode refs.
    if (rmNoise.workletNode) {
        rmNoise.workletNode.port.postMessage({ type: 'bypass', value: rmNoise.bypass });
    }
}

function rmNoise_clearStatusLabel() {
    const jEl = document.getElementById('rmnoise-jitter');
    const lEl = document.getElementById('rmnoise-latency');
    if (jEl) jEl.textContent = '-- frames';
    if (lEl) lEl.textContent = '-- ms';
    const fillEl = document.getElementById('rmnoise-jitter-fill');
    if (fillEl) fillEl.style.width = '0%';
}

// ── Stats ──────────────────────────────────────────────────────────────────────

function rmNoise_startStatsInterval() {
    rmNoise_stopStatsInterval();
    rmNoise.statsInterval = setInterval(rmNoise_updateStats, 500);
}

function rmNoise_stopStatsInterval() {
    if (rmNoise.statsInterval) {
        clearInterval(rmNoise.statsInterval);
        rmNoise.statsInterval = null;
    }
}

function rmNoise_updateStats() {
    if (!rmNoise.ready) return;

    const jitter  = rmNoise.jitterBuf.length;
    const latency = rmNoise.lastLatencyMs;

    // Update modal stats
    const jEl = document.getElementById('rmnoise-jitter');
    const lEl = document.getElementById('rmnoise-latency');
    if (jEl) jEl.textContent = `${jitter} frames`;
    if (lEl) lEl.textContent = `${latency.toFixed(0)} ms`;

    // Jitter bar (max 20 frames = full)
    const ratio    = Math.min(jitter / 20, 1.0);
    const fillEl   = document.getElementById('rmnoise-jitter-fill');
    if (fillEl) {
        fillEl.style.width = `${Math.round(ratio * 100)}%`;
        fillEl.style.backgroundColor =
            jitter <= 6  ? '#28a745' :
            jitter <= 12 ? '#ffc107' : '#dc3545';
    }

}

// ── Filter list ────────────────────────────────────────────────────────────────

function rmNoise_populateFilterList() {
    const sel = document.getElementById('rmnoise-filter-select');
    if (!sel || rmNoise.availableFilters.length === 0) return;

    sel.innerHTML = '';
    const savedFilter = rmNoise.filterNumber;

    for (const f of rmNoise.availableFilters) {
        const opt = document.createElement('option');
        opt.value       = f.filterNumber;
        opt.textContent = f.filterDesc || `Filter ${f.filterNumber}`;
        if (f.filterNumber === savedFilter) opt.selected = true;
        sel.appendChild(opt);
    }
}

function rmNoise_onFilterChanged() {
    const sel = document.getElementById('rmnoise-filter-select');
    if (!sel) return;
    const newFilter = parseInt(sel.value, 10);
    if (isNaN(newFilter)) return;

    rmNoise.filterNumber = newFilter;
    localStorage.setItem('rmnoise_filter', newFilter);

    // Send to server if connected
    if (rmNoise.ws && rmNoise.ws.readyState === WebSocket.OPEN) {
        rmNoise.ws.send(JSON.stringify({
            type:         'ai_filter_selection',
            filterNumber: newFilter,
        }));
        rmNoise_log(`Filter changed to: ${sel.options[sel.selectedIndex]?.textContent}`);
    }
}

// ── Credentials ────────────────────────────────────────────────────────────────

function rmNoise_saveCredentials() {
    const username = (document.getElementById('rmnoise-username')?.value || '').trim();
    const password = (document.getElementById('rmnoise-password')?.value || '').trim();

    if (!username || !password) {
        alert('Username and password are required');
        return;
    }

    localStorage.setItem('rmnoise_username', username);
    localStorage.setItem('rmnoise_password', password);
    localStorage.setItem('rmnoise_filter',   rmNoise.filterNumber);
    localStorage.setItem('rmnoise_mix',      Math.round(rmNoise.mixRatio * 100));
    rmNoise_log('Credentials saved');
}

function rmNoise_loadCredentials() {
    const username = localStorage.getItem('rmnoise_username') || '';
    const password = localStorage.getItem('rmnoise_password') || '';
    const filter   = parseInt(localStorage.getItem('rmnoise_filter') || '1', 10);
    const mix      = parseInt(localStorage.getItem('rmnoise_mix')    || '100', 10);

    const uEl = document.getElementById('rmnoise-username');
    const pEl = document.getElementById('rmnoise-password');
    if (uEl) uEl.value = username;
    if (pEl) pEl.value = password;

    rmNoise.filterNumber = isNaN(filter) ? 1 : filter;
    rmNoise.mixRatio     = isNaN(mix)    ? 1.0 : mix / 100;

    const sel    = document.getElementById('rmnoise-filter-select');
    if (sel) sel.value = rmNoise.filterNumber;

    const mixSlider = document.getElementById('rmnoise-mix-slider');
    const mixLabel  = document.getElementById('rmnoise-mix-value');
    const mixPct    = Math.round(rmNoise.mixRatio * 100);
    if (mixSlider) mixSlider.value = mixPct;
    if (mixLabel)  mixLabel.textContent = mixPct + '% Filtered';
}

// ── Mix slider ─────────────────────────────────────────────────────────────────

function rmNoise_onMixChanged(value) {
    const pct = parseInt(value, 10);
    rmNoise.mixRatio = pct / 100;
    localStorage.setItem('rmnoise_mix', pct);
    const el = document.getElementById('rmnoise-mix-value');
    if (el) el.textContent = pct + '% Filtered';
    // [HB9VQQ] Phase 4b: propagate mix to AudioWorklet
    if (rmNoise.workletNode) {
        rmNoise.workletNode.port.postMessage({ type: 'mix', value: rmNoise.mixRatio });
    }
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function rmNoise_setStatus(text, colour) {
    const el = document.getElementById('rmnoise-status-text');
    if (!el) return;
    el.textContent  = text;
    el.style.color  =
        colour === 'green'  ? '#28a745' :
        colour === 'orange' ? '#fd7e14' :
        colour === 'red'    ? '#dc3545' : '#888';
}

function rmNoise_updateButton() {
    const btn = document.getElementById('rmn-quick-toggle');
    const cog = document.getElementById('rmn-cog-btn');
    if (!btn) return;

    let colour;
    if (rmNoise.connecting) {
        colour = '#fd7e14';  // orange
    } else if (rmNoise.bypass && rmNoise.enabled) {
        colour = '#888';     // grey (bypassed)
    } else if (rmNoise.ready && rmNoise.enabled) {
        colour = '#28a745';  // green
    } else if (!rmNoise.enabled) {
        colour = '#6f42c1';  // purple (idle)
    } else {
        colour = '#dc3545';  // red (failed)
    }

    btn.style.backgroundColor = colour;
    if (cog) cog.style.backgroundColor = colour;

    // Original button
    const origBtn = document.getElementById('rmn-bypass-modal-btn');
    if (origBtn) {
        origBtn.disabled = !(rmNoise.ready && rmNoise.enabled);
    }
}

function rmNoise_syncCheckbox() {
    const cb = document.getElementById('rmnoise-enable-checkbox');
    if (cb) cb.checked = rmNoise.enabled;
}

function rmNoise_log(message) {
    const ts  = new Date().toTimeString().slice(0, 8);
    const div = document.getElementById('rmnoise-log');
    if (!div) return;
    const line = document.createElement('div');
    line.textContent = `[${ts}] ${message}`;
    div.appendChild(line);
    div.scrollTop = div.scrollHeight;
}

// ── Modal ──────────────────────────────────────────────────────────────────────

function openRMNoiseModal() {
    const modal = document.getElementById('rmnoise-modal');
    if (!modal) return;
    rmNoise_loadCredentials();
    // ── HB9VQQ BEGIN: rmnoise — sync checkbox + bypass btn state on open ──
    const cb = document.getElementById('rmnoise-enable-checkbox');
    if (cb) cb.checked = rmNoise.enabled;
    const bypassBtn = document.getElementById('rmn-bypass-modal-btn');
    if (bypassBtn) {
        const bypassed = window.rmNoiseBridge && window.rmNoiseBridge.bypass;
        bypassBtn.style.background = bypassed ? '#888' : '#6f42c1';
        bypassBtn.textContent = bypassed ? '⏭ BYPASSED' : '⏭ Bypass';
    }
    // ── HB9VQQ END: rmnoise ──
    modal.style.display = 'flex';
}

function closeRMNoiseModal() {
    const modal = document.getElementById('rmnoise-modal');
    if (modal) modal.style.display = 'none';
}

// Close on backdrop click
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('rmnoise-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeRMNoiseModal();
        });
    }

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeRMNoiseModal();
    });

    // RMN button: always opens modal
    const rmnBtn = document.getElementById('rmn-quick-toggle');
    if (rmnBtn) {
        rmnBtn.addEventListener('click', (e) => {
            openRMNoiseModal();
        });
    }

    // Load saved credentials into modal fields
    rmNoise_loadCredentials();

    // Initialise button state
    rmNoise_updateButton();

    // Apply mode gating for the initial mode.
    // ── HB9VQQ BEGIN: rmnoise — replace window.currentMode (UberSDR global) with DOM read ──
    setTimeout(() => {
        const initialMode = document.getElementById('mode')?.value || 'usb';
        if (window.rmNoise_updateModeSupport) {
            window.rmNoise_updateModeSupport(initialMode);
        }
    }, 0);
    // ── HB9VQQ END: rmnoise ──
});

// ── Mode support gating ────────────────────────────────────────────────────────
//
// RMNoise only makes sense for SSB/CW modes (USB, LSB, CWU, CWL).
// For AM, FM, NFM, SAM, WFM etc. the denoiser produces garbage because the
// audio bandwidth and spectral character are completely different.
//
// Called by app.js setMode() on every mode change and on initial page load.
//
const RM_SUPPORTED_MODES = new Set(['usb', 'lsb', 'cwu', 'cwl']);

function rmNoise_isModeSupported(mode) {
    return RM_SUPPORTED_MODES.has((mode || '').toLowerCase());
}

/**
 * Update RMNoise UI and connection state for the given mode.
 * - Supported modes  (USB/LSB/CWU/CWL): enable button + checkbox
 * - Unsupported modes (AM/FM/NFM/…):    disable button + checkbox, disconnect if active
 */
async function rmNoise_updateModeSupport(mode) {
    const supported = rmNoise_isModeSupported(mode);

    const btn     = document.getElementById('rmn-quick-toggle');
    const cogBtn  = document.getElementById('rmn-cog-btn');
    const cb      = document.getElementById('rmnoise-enable-checkbox');

    if (supported) {
        // Re-enable controls
        if (btn) {
            btn.disabled = false;
            btn.title    = 'Toggle RM Noise AI Denoising';
            btn.style.opacity = '';
            btn.style.cursor  = '';
        }
        if (cogBtn) {
            cogBtn.disabled = false;
            cogBtn.style.opacity = '';
            cogBtn.style.cursor  = '';
        }
        if (cb) {
            cb.disabled = false;
            cb.checked = rmNoise.enabled;
        }
        // If bypass was set due to unsupported mode, clear it now
        if (rmNoise.enabled && rmNoise.bypass) {
            rmNoise.bypass = false;
            if (rmNoise.workletNode) {
                rmNoise.workletNode.port.postMessage({ type: 'bypass', value: false });
            }
            rmNoise_setStatus('Connected ✓', 'green');
            rmNoise_updateButton();
            const bypassBtn = document.getElementById('rmn-bypass-modal-btn');
            if (bypassBtn) {
                bypassBtn.textContent = '⏭ Bypass';
                bypassBtn.style.background = '#6f42c1';
            }
            rmNoise_log(`Mode changed to ${mode.toUpperCase()} — RMNoise resumed`);
        }    } else {
        if (cb) cb.disabled = true;

        // Enable bypass if currently active — keeps connection alive so switching
        // back to SSB/CW resumes instantly without needing to reconnect.
        if ((rmNoise.enabled || rmNoise.ready) && !rmNoise.bypass) {
            rmNoise_log(`Mode changed to ${mode.toUpperCase()} — RMNoise bypassed (unsupported mode)`);
            rmNoise.bypass = true;
            if (rmNoise.workletNode) {
                rmNoise.workletNode.port.postMessage({ type: 'bypass', value: true });
            }
            rmNoise_setStatus('Bypassed (unsupported mode)', 'grey');
            // Don't disable the RMN button — just set it grey.
            // Chrome ignores backgroundColor on disabled buttons, so we keep it
            // enabled but styled grey to show bypassed state.
            if (btn) {
                btn.disabled      = false;
                btn.style.opacity = '0.6';
                btn.style.backgroundColor = '#888';
            }
            if (cogBtn) {
                cogBtn.disabled      = false;
                cogBtn.style.opacity = '0.6';
                cogBtn.style.backgroundColor = '#888';
            }
            const bypassBtn = document.getElementById('rmn-bypass-modal-btn');
            if (bypassBtn) {
                bypassBtn.textContent = '⏭ BYPASSED';
                bypassBtn.style.background = '#888';
            }
        } else if (!rmNoise.enabled && !rmNoise.ready) {
            // Not active — just disable the button
            if (btn) {
                btn.disabled = true;
                btn.title    = 'RMNoise is only available in USB / LSB / CWU / CWL modes';
                btn.style.opacity = '0.4';
                btn.style.cursor  = 'not-allowed';
            }
            if (cogBtn) {
                cogBtn.disabled = true;
                cogBtn.style.opacity = '0.4';
                cogBtn.style.cursor  = 'not-allowed';
            }
        }
    }
}

// ── Sample-rate change flush ───────────────────────────────────────────────────
//
// Called by app.js from both the Opus and PCM AudioContext-recreation blocks
// whenever the server sample rate changes (e.g. switching from LSB/USB to AM/FM).
// Must be called BEFORE rmNoise_process() receives the first frame at the new rate.
//
function rmNoise_onSampleRateChange(newRate) {
    if (!window.rmNoiseBridge || !window.rmNoiseBridge.enabled) return;
    rmNoise_log(`Sample rate changed to ${newRate} Hz — flushing pipeline`);

    rmNoise.inputRate     = newRate;
    rmNoise.accumIn       = new Float32Array(0);
    rmNoise.lpfCoeffs     = null;
    rmNoise.lpfState      = null;
    rmNoise.lpfRate       = 0;
    rmNoise.accumOut      = new Float32Array(0);
    rmNoise.blendedBuf    = new Float32Array(0);
    rmNoise.origFrameMap.clear();
    rmNoise.origBlendDelay = null;
    rmNoise.jitterBuf     = [];           // critical: discard stale 8 kHz frames
    rmNoise.primed        = false;
    rmNoise.frameNum      = BigInt(0);
    rmNoise.sendTimes.clear();
    rmNoise.rateChangedAt = performance.now(); // arms the 300 ms in-flight discard window
    rmNoise.downsampleOSB = null;
    rmNoise.upsampleOSB   = null;
}

// ── Expose globals for app.js ──────────────────────────────────────────────────
window.toggleRMNoise        = toggleRMNoise;
window.toggleRMNoiseQuick   = toggleRMNoiseQuick;
window.toggleRMNoiseBypass  = toggleRMNoiseBypass;
window.openRMNoiseModal     = openRMNoiseModal;
window.closeRMNoiseModal    = closeRMNoiseModal;
window.rmNoise_saveCredentials      = rmNoise_saveCredentials;
window.rmNoise_onFilterChanged      = rmNoise_onFilterChanged;
window.rmNoise_onMixChanged         = rmNoise_onMixChanged;
window.rmNoise_process              = rmNoise_process;
window.rmNoise_onSampleRateChange   = rmNoise_onSampleRateChange;
window.rmNoise_updateModeSupport    = rmNoise_updateModeSupport;
window.rmNoise_isModeSupported      = rmNoise_isModeSupported;
window.rmNoise_ensureWorklet        = rmNoise_ensureWorklet;   // [HB9VQQ] Phase 4b: called from pcm-player.js createContext