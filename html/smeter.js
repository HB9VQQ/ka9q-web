const canvas = document.getElementById('smeter');
const ctx = canvas.getContext('2d');
const cWidth = canvas.width;
const cHeight = canvas.height;
ctx.fillStyle = "#000000";
ctx.fillRect(0,0, cWidth, cHeight); 
const updateSMeter = createUpdateSMeter();
const computeSUnits = createComputeSUnits();

    // Create and paint a bargraph which represents the S meter signal level
    // The S meter is a logarithmic scale that is not linear.  The S meter is defined as S0 to S9+60dBm
    // S0 = -127dBm, S9 = -73dBm, S9+60 = -13dBm    

    // Need to normalize the SignalLevel to be between 0 and 1
    // Max bar width is at S9+60 dBm which is -73 + 60 = -13dBm input signal Level
    // Min bar width is at S0 which is -73 - 9*6 = -127dBm input signal Level
    // So the range is 127-13 = 114dBm

    // An S meter is not linear, scaling per "division" is 6db per S unit S9 (-73)
    // Then 10db per division from S9 (-73) to S9+60 (-13)
    // Adjust the scaler differently below and above S9 taking their respective spans into account

    const smallestSignal = -127;
    const biggestSignal = -13;
    const s9SignalLevel = -73;
    const meterSpan = biggestSignal - smallestSignal;   // Span of the signal range (114) in db to map to the width of the s0 to S9+60 bargraph range
    const belowS9Span = s9SignalLevel - smallestSignal  // Span of the signal range in db below S9 (54dB=9x6) to map to the s0-s9 bargraph range
    const aboveS9Span = 60;                             // Span of the signal range in db above S9 (60dB) to map to the S9+60 bargraph range
    const adjustedSignalAtS9 = meterSpan - aboveS9Span; // dB value of the adjusted input signal at an S9 value
    const s9pfs = 0.62;                                 // Set to the percentage of full scale in the bargraph that corresponds to S9 (62% on TenTec Orion)
    const s9Plus60pfs = 1 - s9pfs;                      // Remaining span scaler for drawing bar above S9 (1-62% = 38%)

var meterType = 0;  // 0 = RSSI, 1 = SNR, updated in radio.js when the RSSI/SNR button is clicked or loaded from storage

function dB2power(dB) { 
    return Math.pow(10, dB / 10); 
}

function power2dB(power) {
    return 10 * Math.log10(power);
}   

function createUpdateSMeter() {
    let lastMax = -200; // Static variable that holds the max value for the max hold bar graph
    let lastSNR = -100;
    let executionCount = 0;     // Static variable that counts the number of times the updateSMeter function is called
    let executionCountSNR = 0;  // Static variable that counts the number of times the updateSMeter function is called

    return function updateSMeter(SignalLevel, noiseDensity, Bandwidth, maxHold) {
        const maxBarHeight = 0.3;  // 30% of the canvas height
        const executionCountHit = 30; // Number of times (seconds*10?) the updateSMeter function is called before the max hold bar graph is updated

        // Experimental SNR calculation and display
        var noise_power = dB2power(noiseDensity) * Bandwidth;
        var signal_plus_noise_power = dB2power(SignalLevel);
        var SignalToNoiseRatio;

        var spnovernp = signal_plus_noise_power / noise_power;
        if ((spnovernp - 1) > 0)
            SignalToNoiseRatio = power2dB(spnovernp - 1);
        else
            SignalToNoiseRatio = -100;  // Avoid calling power2dB with a negative number

        // clear Canvas 
        ctx.clearRect(0, 0, cWidth, cHeight);
        var adjustedSignal = SignalLevel - smallestSignal;  // Adjust the dB signal to a positive number with smallestSignal as 0, and biggestSignal as -13
        var normSig;

        if (meterType == 0) {
            //The RSSI Meter: An S9 signal should paint to s9pfs (62%) of full scale.  Signals above S9 are scaled to paint to the upper (right) 38% of the scale.
            if (SignalLevel <= s9SignalLevel) {
                normSig = adjustedSignal / belowS9Span * s9pfs;
            } else {
                normSig = s9pfs + (adjustedSignal - adjustedSignalAtS9) / aboveS9Span * s9Plus60pfs;
            }
        } else   // SNR meter
        if (meterType == 1)
            normSig = SignalToNoiseRatio / 50 + 0.1; // 50dB SNR is full scale, -10db is the minimum value 
        else
            normSig = Number(input_samprate) / Number(samples_since_over);

        // Protect over under range
        if (normSig > 1) {
            normSig = 1;
        }
        if (normSig < 0) {
            normSig = 0;
        }

        if (maxHold == true) {
            executionCount++;
            executionCountSNR++;
            if (executionCount > executionCountHit) {
                // Done holding the last RSI value, get the latest one
                executionCount = 0;
                lastMax = normSig;
            }
            if (executionCountSNR > executionCountHit) {
                // Done holding the last SNR value, get the latest one
                executionCountSNR = 0;
                lastSNR = SignalToNoiseRatio;
            }
            if (normSig > lastMax) {
                lastMax = normSig;
                executionCount = executionCountHit / 2;   // Reset the upper bargraph hold counter so it is held for 15 counts
            }
            if (SignalToNoiseRatio > lastSNR) {
                lastSNR = SignalToNoiseRatio;
                executionCountSNR = executionCountHit / 2; // Reset the SNR hold counter so SNR text display is held for 15 counts
            }

            // --- SNR meter custom coloring for maxHold ---
            if (meterType == 1) {
                // SNR spans from -10 to +50
                const zeroPoint = cWidth * (10 / 60); // 1/6 of the width

                // Top 1/3: max hold bar (color as before)
                if (lastSNR < 0) {
                    // Red bar: from zeroPoint leftward, proportional to SNR
                    const redFrac = Math.min(1, Math.max(0, -lastSNR / 10)); // 0 to 1 as SNR goes 0 to -10
                    const redWidth = zeroPoint * redFrac;
                    ctx.fillStyle = "red";
                    ctx.fillRect(zeroPoint - redWidth, 0, redWidth, cHeight * maxBarHeight);
                } else if (lastSNR > 0) {
                    // Blue bar: from zeroPoint rightward, proportional to SNR (max at +50)
                    const blueFrac = Math.min(1, lastSNR / 50); // 0 to 1 as SNR goes 0 to +50
                    const blueWidth = (cWidth - zeroPoint) * blueFrac;
                    ctx.fillStyle = "rgb(1, 136, 199)";
                    ctx.fillRect(zeroPoint, 0, blueWidth, cHeight * maxBarHeight);
                }
                // If SNR == 0, nothing is drawn (all blank)

                // Bottom 2/3: real time bar graph, but color and position as SNR logic
                if (SignalToNoiseRatio < 0) {
                    const redFrac = Math.min(1, Math.max(0, -SignalToNoiseRatio / 10));
                    const redWidth = zeroPoint * redFrac;
                    ctx.fillStyle = "red";
                    ctx.fillRect(zeroPoint - redWidth, cHeight * maxBarHeight, redWidth, cHeight - cHeight * maxBarHeight);
                } else if (SignalToNoiseRatio > 0) {
                    const blueFrac = Math.min(1, SignalToNoiseRatio / 50);
                    const blueWidth = (cWidth - zeroPoint) * blueFrac;
                    ctx.fillStyle = "rgb(1, 136, 199)";
                    ctx.fillRect(zeroPoint, cHeight * maxBarHeight, blueWidth, cHeight - cHeight * maxBarHeight);
                }
                // If SNR == 0, nothing is drawn (all blank)
            } else if (meterType == 0) {
                // RSSI meter: fill with gradient
                var gradient;
                gradient = ctx.createLinearGradient(0, 0, cWidth, 0);
                gradient.addColorStop(1, "rgb(128,82,0)");
                gradient.addColorStop(s9pfs, "rgb(255,0, 0)");
                gradient.addColorStop(.6, "green");
                gradient.addColorStop(0, 'green');
                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, cWidth * lastMax, cHeight * maxBarHeight);
                ctx.fillRect(0, cHeight * maxBarHeight, cWidth * normSig, cHeight - cHeight * maxBarHeight);
            } else {
                // OVF meter
                ctx.fillStyle = "orange";
                ctx.fillRect(0, 0, cWidth * lastMax, cHeight * maxBarHeight);
                ctx.fillRect(0, cHeight * maxBarHeight, cWidth * normSig, cHeight - cHeight * maxBarHeight);
            }

            // Display the held SNR value
            if (lastSNR === -100) {
                document.getElementById('snr').textContent = `SNR: -\u221E dB`;
                document.getElementById('snr_data').textContent = `| SNR: -\u221E`;
            } else {
                document.getElementById('snr').textContent = `SNR: ${lastSNR.toFixed(0)} dB`;
                document.getElementById('snr_data').textContent = `| SNR: ${lastSNR.toFixed(0)}`;
            }
        }
        else // max hold is false
        {
            // --- SNR meter custom coloring ---
            if (meterType == 1) {
                // SNR spans from -10 to +50
                const zeroPoint = cWidth * (10 / 60); // 1/6 of the width

                if (SignalToNoiseRatio < 0) {
                    // Red bar: from zeroPoint leftward, proportional to SNR
                    const redFrac = Math.min(1, Math.max(0, -SignalToNoiseRatio / 10)); // 0 to 1 as SNR goes 0 to -10
                    const redWidth = zeroPoint * redFrac;
                    ctx.fillStyle = "red";
                    ctx.fillRect(zeroPoint - redWidth, 0, redWidth, cHeight);
                } else if (SignalToNoiseRatio > 0) {
                    // Blue bar: from zeroPoint rightward, proportional to SNR (max at +50)
                    const blueFrac = Math.min(1, SignalToNoiseRatio / 50); // 0 to 1 as SNR goes 0 to +50
                    const blueWidth = (cWidth - zeroPoint) * blueFrac;
                    ctx.fillStyle = "rgb(1, 136, 199)";
                    ctx.fillRect(zeroPoint, 0, blueWidth, cHeight);
                }
                // If SNR == 0, nothing is drawn (all blank)
            } else if (meterType == 0) {
                // RSSI meter: fill with gradient (fix for maxHold==false)
                var gradient;
                gradient = ctx.createLinearGradient(0, 0, cWidth, 0);
                gradient.addColorStop(1, "rgb(128,82,0)");
                gradient.addColorStop(s9pfs, "rgb(255,0, 0)");
                gradient.addColorStop(.6, "green");
                gradient.addColorStop(0, 'green');
                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, cWidth * normSig, cHeight);
            } else {
                ctx.fillStyle = "orange";
                ctx.fillRect(0, 0, cWidth * normSig, cHeight);
            }
            // Display the real-time SNR value
            if (SignalToNoiseRatio === -100) {
                document.getElementById('snr').textContent = `SNR: -\u221E dB`;
                document.getElementById('snr_data').textContent = `| SNR: -\u221E`;
            } else {
                document.getElementById('snr').textContent = `SNR: ${SignalToNoiseRatio.toFixed(0)} dB`;
                document.getElementById('snr_data').textContent = `| SNR: ${SignalToNoiseRatio.toFixed(0)}`;
            }
        }

        if (meterType == 1) { // SNR meter
            document.getElementById('snr_units').textContent = "dB | SNR: ";
        }
        else {
            if (meterType == 0) { // RSSI meter
                document.getElementById('snr_units').textContent = "dB | Signal: ";
            }
            else
                document.getElementById('snr_units').textContent = "dB | OVR:";
        }

        // Draw the border
        ctx.strokeRect(0, 0, cWidth, cHeight);
        // Draw analog S-meter if enabled
        if (typeof enableAnalogSMeter !== "undefined" && enableAnalogSMeter) {
            if (typeof _smeterMode !== "undefined" && _smeterMode === "digital") {
                drawDigitalSMeter(SignalLevel, SignalToNoiseRatio);
            } else {
                drawAnalogSMeter(SignalLevel, SignalToNoiseRatio);
            }
        }

        return power2dB(noise_power);
    };
}

function createComputeSUnits() {
    let lastMax1 = -200;
    let executionCount1 = 0; 

    return function computeSUnits(SignalLevel, maxHold) {
        const executionCountHit1 = 20; // Number of times (seconds*10?) the updateSMeter function is called before the max hold bar graph is updated
        var p;

        // Display the power level (dBm) realtime, or max hold level
        if (maxHold == true) {
            executionCount1++;
            if(executionCount1 > executionCountHit1) {
                executionCount1 = 0;
                lastMax1 = SignalLevel;
            }
            if (SignalLevel > lastMax1) {
                lastMax1 = SignalLevel;
            }
            p = Math.round(lastMax1);       // Use the max hold value
            document.getElementById("pwr_data").textContent = ` Power: ${lastMax1.toFixed()}`;
        }
        else {
            p = Math.round(SignalLevel);    // Use the real time value
            document.getElementById("pwr_data").textContent = ` Power: ${SignalLevel.toFixed(0)}`;
        }
    
        // Compute the S units based on the power level p from above, being real time or max hold
        var s;
        var sm1;
        if (p <= -73) {     
            sm1 = Math.round((p + 127) / 6);       // S0 to S9
            if (sm1 < 0) sm1 = 0;                // S0 is the lowest value
            s = 'S' +  sm1;    // S0 to S9
        } 
        else {
            s = 'S9+' + ((p + 73) / 10) * 10;       // S9+1 to S9+60
        }

        // Set the color to red if over S9, green if S9 or below
        var len = s.length;
        if (len > 2) {
            document.getElementById("s_data").style.color = "red";
        }
        else {
            document.getElementById("s_data").style.color = "green";
        }
        // Display the S units
        document.getElementById("s_data").textContent = s; 

        // Call analog S-meter draw function with the current signal level (p) if enabled
        if (typeof drawAnalogSMeter === "function" && typeof enableAnalogSMeter !== "undefined" && enableAnalogSMeter) {
        }
    }
};

let _smoothedSignal = null;
let _smoothedSNR = null;
const _SMOOTH = 0.2; // EMA factor: lower = smoother
function drawAnalogSMeter(signalStrength, snr) {
    _smoothedSignal = (_smoothedSignal === null) ? signalStrength : _smoothedSignal * (1 - _SMOOTH) + signalStrength * _SMOOTH;
    if (snr > 0) _smoothedSNR = (_smoothedSNR === null) ? snr : _smoothedSNR * (1 - _SMOOTH) + snr * _SMOOTH;
    signalStrength = _smoothedSignal;
    snr = (_smoothedSNR !== null && _smoothedSNR > 0) ? _smoothedSNR : -1;
    const canvas = document.getElementById("sMeter");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H * 0.65, R = W * 0.43;

    ctx.clearRect(0, 0, W, H);

    // Radial background
    const bg = ctx.createRadialGradient(cx, cy, R*0.1, cx, cy, R*1.3);
    bg.addColorStop(0, '#162016'); bg.addColorStop(1, '#060c06');
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(cx, cy, R*1.12, Math.PI, 2*Math.PI);
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();

    // Bezel ring
    ctx.beginPath(); ctx.arc(cx, cy, R*1.1, Math.PI, 2*Math.PI);
    ctx.strokeStyle = '#2a4a2a'; ctx.lineWidth = 4; ctx.stroke();

    // White arc S1-S9
    ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI, Math.PI*1.5);
    ctx.strokeStyle = '#cccccc'; ctx.lineWidth = 6; ctx.stroke();

    // Red arc S9+
    ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI*1.5, 2*Math.PI);
    ctx.strokeStyle = '#cc2200'; ctx.lineWidth = 6; ctx.stroke();

    // Red glow
    ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI*1.5, 2*Math.PI);
    ctx.strokeStyle = 'rgba(255,50,0,0.15)'; ctx.lineWidth = 14; ctx.stroke();

    const scale = [
        {l:'S1',f:0},{l:'S3',f:0.125},{l:'S5',f:0.25},{l:'S7',f:0.375},{l:'S9',f:0.5},
        {l:'+20',f:0.667},{l:'+40',f:0.833},{l:'+60',f:1.0}
    ];

    // Minor + major ticks
    for (let i = 0; i <= 16; i++) {
        const f = i/16, a = Math.PI + Math.PI*f;
        const isMaj = scale.some(s => Math.abs(s.f - f) < 0.01);
        ctx.beginPath();
        ctx.moveTo(cx + R*Math.cos(a), cy + R*Math.sin(a));
        ctx.lineTo(cx + (isMaj ? R*0.80 : R*0.88)*Math.cos(a), cy + (isMaj ? R*0.80 : R*0.88)*Math.sin(a));
        ctx.strokeStyle = f > 0.5 ? '#993311' : '#999999';
        ctx.lineWidth = isMaj ? 1.5 : 0.8; ctx.stroke();
    }

    // Labels
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const s of scale) {
        const a = Math.PI + Math.PI*s.f;
        ctx.font = `bold ${s.f > 0.5 ? '9' : '10'}px monospace`;
        ctx.fillStyle = s.f > 0.5 ? '#ff5533' : '#dddddd';
        ctx.fillText(s.l, cx + R*0.65*Math.cos(a), cy + R*0.65*Math.sin(a));
    }

    // Needle fraction
    let fraction;
    if (signalStrength <= -73) {
        let su = Math.max(0, Math.min(8, (signalStrength + 127) / 6 - 1));
        fraction = su / 8 * 0.5;
    } else if (signalStrength >= -13) {
        fraction = 1;
    } else {
        fraction = 0.5 + ((signalStrength + 73) / 60) * 0.5;
    }
    fraction = Math.max(0, Math.min(1, fraction));
    const na = Math.PI + Math.PI * fraction;

    // Needle with shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2;
    ctx.beginPath();
    ctx.moveTo(cx - R*0.1*Math.cos(na), cy - R*0.1*Math.sin(na));
    ctx.lineTo(cx + R*0.85*Math.cos(na), cy + R*0.85*Math.sin(na));
    const ng = ctx.createLinearGradient(cx, cy, cx + R*0.85*Math.cos(na), cy + R*0.85*Math.sin(na));
    ng.addColorStop(0, '#ff6600'); ng.addColorStop(1, '#ff2200');
    ctx.strokeStyle = ng; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.stroke();
    ctx.restore();

    // Pivot
    const piv = ctx.createRadialGradient(cx-2, cy-2, 1, cx, cy, 8);
    piv.addColorStop(0, '#6a9a6a'); piv.addColorStop(1, '#1a2a1a');
    ctx.beginPath(); ctx.arc(cx, cy, 8, 0, 2*Math.PI);
    ctx.fillStyle = piv; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, 8, 0, 2*Math.PI);
    ctx.strokeStyle = '#2a5a2a'; ctx.lineWidth = 1.5; ctx.stroke();

    // Text
    ctx.font = '11px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#88bb88';
    ctx.fillText(`Signal: ${Math.round(signalStrength)} dBm`, cx, H - 18);
    ctx.fillStyle = snr > 0 ? '#aaddaa' : '#445544';
    ctx.fillText(`SNR: ${snr > 0 ? Math.round(snr) + ' dB' : 'N/A'}`, cx, H - 5);
}
// ── Digital S-meter ──
let _smeterMode = localStorage.getItem('smeterMode') || 'analog';

function setSMeterMode(mode) {
  _smeterMode = mode;
  localStorage.setItem('smeterMode', mode);
  const aw = document.getElementById('smeter-analog-wrap');
  const dw = document.getElementById('smeter-digital-wrap');
  const ba = document.getElementById('smeter-mode-analog');
  const bd = document.getElementById('smeter-mode-digital');
  if (mode === 'analog') {
    aw.style.display = ''; dw.style.display = 'none';
    if (ba) { ba.style.background='#1a2a3a'; ba.style.color='#00d4c8'; ba.style.borderColor='#00d4c8'; }
    if (bd) { bd.style.background='transparent'; bd.style.color='#2a4a5a'; bd.style.borderColor='#2a4a5a'; }
  } else {
    aw.style.display = 'none'; dw.style.display = '';
    if (bd) { bd.style.background='#1a2a3a'; bd.style.color='#00d4c8'; bd.style.borderColor='#00d4c8'; }
    if (ba) { ba.style.background='transparent'; ba.style.color='#2a4a5a'; ba.style.borderColor='#2a4a5a'; }
  }
}

function drawDigitalSMeter(signal, snr) {
    // Apply same smoothing as analog meter
    _smoothedSignal = (_smoothedSignal === null) ? signal : _smoothedSignal * (1 - _SMOOTH) + signal * _SMOOTH;
    if (snr > 0) _smoothedSNR = (_smoothedSNR === null) ? snr : _smoothedSNR * (1 - _SMOOTH) + snr * _SMOOTH;
    signal = _smoothedSignal;
    snr = (_smoothedSNR !== null && _smoothedSNR > 0) ? _smoothedSNR : -1;
  const canvas = document.getElementById('sMeterDigital');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);

  ctx.fillStyle = '#111a00';
  ctx.fillRect(0,0,W,H);
  ctx.strokeStyle = '#2a3a00'; ctx.lineWidth = 1;
  ctx.strokeRect(0.5,0.5,W-1,H-1);

  let fraction;
  if (signal <= -73) { let su=Math.max(0,Math.min(8,(signal+127)/6-1)); fraction=su/8*0.5; }
  else if (signal >= -13) { fraction=1; }
  else { fraction=0.5+((signal+73)/60)*0.5; }
  fraction = Math.max(0,Math.min(1,fraction));

  let sLabel;
  if (signal <= -73) { sLabel = 'S' + Math.max(1,Math.round((signal+127)/6)); }
  else { sLabel = 'S9+' + Math.round(signal+73); }

  ctx.font = 'bold 38px monospace';
  ctx.fillStyle = signal > -73 ? '#cc4400' : '#88cc00';
  ctx.textAlign = 'center';
  ctx.fillText(sLabel, W/2, 48);

  ctx.font = '11px monospace'; ctx.fillStyle = '#557700'; ctx.textAlign = 'right';
  ctx.fillText(Math.round(signal) + ' dBm', W-8, 64);

  ctx.font = '11px monospace'; ctx.fillStyle = snr>0?'#aabb00':'#556600'; ctx.textAlign = 'left';
  ctx.fillText('SNR: ' + (snr>0 ? Math.round(snr)+' dB' : 'N/A'), 8, 64);

  ctx.fillStyle = '#0d1500';
  ctx.fillRect(8, 70, W-16, 10);
  const barColor = fraction>0.75?'#cc4400':fraction>0.5?'#aaaa00':'#44aa00';
  ctx.fillStyle = barColor;
  ctx.fillRect(8, 70, (W-16)*fraction, 10);

  // Scale ticks on bar
  const ticks = [0, 0.125, 0.25, 0.375, 0.5, 0.667, 0.833, 1.0];
  for (const f of ticks) {
    const x = 8 + (W-16)*f;
    ctx.fillStyle = '#2a3a00';
    ctx.fillRect(x-0.5, 70, 1, 10);
  }
}

// Init mode on load
document.addEventListener('DOMContentLoaded', () => setSMeterMode(_smeterMode));
