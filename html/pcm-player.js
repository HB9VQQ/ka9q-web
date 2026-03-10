function PCMPlayer(option) {
    this.init(option);
}

PCMPlayer.prototype.init = function(option) {
    var defaults = {
        encoding: '16bitInt',
        channels: 1,
        sampleRate: 48000,
        flushingTime: 500
    };
    this.option = Object.assign({}, defaults, option);
    this.samples = new Float32Array();
    this.flush = this.flush.bind(this);
    this._destroyed = false;                              // [HB9VQQ] race-condition guard
    this.interval = setInterval(this.flush, this.option.flushingTime);
    this.maxValue = this.getMaxValue();
    this.typedArray = this.getTypedArray();
    this.createContext();
};

PCMPlayer.prototype.getMaxValue = function () {
    var encodings = {
        '8bitInt': 128,
        '16bitInt': 32768,
        '32bitInt': 2147483648,
        '32bitFloat': 1
    }

    return encodings[this.option.encoding] ? encodings[this.option.encoding] : encodings['16bitInt'];
};

PCMPlayer.prototype.getTypedArray = function () {
    var typedArrays = {
        '8bitInt': Int8Array,
        '16bitInt': Int16Array,
        '32bitInt': Int32Array,
        '32bitFloat': Float32Array
    }

    return typedArrays[this.option.encoding] ? typedArrays[this.option.encoding] : typedArrays['16bitInt'];
};

PCMPlayer.prototype.createContext = function() {
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // context needs to be resumed on iOS and Safari (or it will stay in "suspended" state)
    this.audioCtx.resume();
    //this.audioCtx.onstatechange = () => console.log(this.audioCtx.state);   // if you want to see "Running" state in console and be happy about it

    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.value = 1;

    // [HB9VQQ] StereoPannerNode: gainNode → _pannerNode → destination
    this._pannerNode = this.audioCtx.createStereoPanner();
    this._pannerNode.pan.value = 0;
    this.gainNode.connect(this._pannerNode);
    this._pannerNode.connect(this.audioCtx.destination);

    this.startTime = this.audioCtx.currentTime;
};

PCMPlayer.prototype.resume = function() {
    this.audioCtx.resume();
}

PCMPlayer.prototype.isTypedArray = function(data) {
    return (data.byteLength && data.buffer && data.buffer.constructor == ArrayBuffer);
};

PCMPlayer.prototype.feed = function(data) {
    if (!this.isTypedArray(data)) {
        console.log("feed: not typed array");
        return;
    }
    var fdata = this.getFormatedValue(data);
    var tmp = new Float32Array(this.samples.length + fdata.length);
    tmp.set(this.samples, 0);
    tmp.set(fdata, this.samples.length);
    this.samples = tmp;
    this.audioCtx.resume();
};

PCMPlayer.prototype.getFormatedValue = function(data) {
    var ndata = new this.typedArray(data.buffer),
        float32 = new Float32Array(ndata.length),
        i;
    for (i = 0; i < ndata.length; i++) {
        float32[i] = ndata[i] / this.maxValue;
    }
    return float32;
};

PCMPlayer.prototype.volume = function(volume) {
    this.gainNode.gain.value = volume;
};

// [HB9VQQ] Stereo pan: -1.0 = full left, 0 = centre, +1.0 = full right
PCMPlayer.prototype.pan = function(value) {
    if (this._pannerNode) {
        this._pannerNode.pan.value = Math.max(-1, Math.min(1, value));
    }
};

// [HB9VQQ] Start recording post-gain/post-pan audio to a WebM file.
// Taps MediaStreamDestination from _pannerNode so recording reflects
// both volume and pan settings. On stopRecording() the file is
// auto-downloaded as ka9q-recording-<ISO timestamp>.webm.
PCMPlayer.prototype.startRecording = function() {
    if (this._mediaRecorder) return;           // already recording — no-op
    if (!this._pannerNode) return;             // context not ready

    var dest = this.audioCtx.createMediaStreamDestination();
    this._pannerNode.connect(dest);
    this._recordingDest = dest;
    this._recordingChunks = [];

    var self = this;
    this._mediaRecorder = new MediaRecorder(dest.stream);

    this._mediaRecorder.ondataavailable = function(e) {
        if (e.data && e.data.size > 0) {
            self._recordingChunks.push(e.data);
        }
    };

    this._mediaRecorder.onstop = function() {
        // disconnect recording tap before touching chunks
        if (self._recordingDest) {
            try { self._pannerNode.disconnect(self._recordingDest); } catch (ignore) {}
        }
        var blob = new Blob(self._recordingChunks, { type: 'audio/webm' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'ka9q-recording-' +
            new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '') + '.webm';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        self._recordingChunks = null;
        self._recordingDest   = null;
        self._mediaRecorder   = null;
    };

    this._mediaRecorder.start();
};

// [HB9VQQ] Stop an active recording and trigger download.
PCMPlayer.prototype.stopRecording = function() {
    if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
        this._mediaRecorder.stop();   // onstop fires asynchronously → handles download + cleanup
    }
};

PCMPlayer.prototype.destroy = function() {
    this._destroyed = true;            // [HB9VQQ] tell flush() to bail before touching closed ctx

    // Stop any active recording cleanly before closing the audio context
    if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
        try { this._mediaRecorder.stop(); } catch (ignore) {}
    }

    if (this.interval) {
        clearInterval(this.interval);
        this.interval = null;
    }
    this.samples = null;
    this.audioCtx.close();
    this.audioCtx = null;
};

PCMPlayer.prototype.flush = function() {
    if (this._destroyed) return;       // [HB9VQQ] guard: interval may fire after destroy()
    if (!this.samples.length) return;
    var bufferSource = this.audioCtx.createBufferSource(),
        length = this.samples.length / this.option.channels,
        audioBuffer = this.audioCtx.createBuffer(this.option.channels, length, this.option.sampleRate),
        audioData,
        channel,
        offset,
        i,
        decrement;

    for (channel = 0; channel < this.option.channels; channel++) {
        audioData = audioBuffer.getChannelData(channel);
        offset = channel;
        decrement = 50;
        for (i = 0; i < length; i++) {
            audioData[i] = this.samples[offset];
            /* fadein */
// just make this a simple copy to eliminate thumping - KA9Q 7 March 2024
//            if (i < 50) {
//                audioData[i] =  (audioData[i] * i) / 50;
//            }
            /* fadeout*/
//            if (i >= (length - 51)) {
//                audioData[i] =  (audioData[i] * decrement--) / 50;
//            }
            offset += this.option.channels;
        }
    }

    if (this.startTime < this.audioCtx.currentTime) {
        this.startTime = this.audioCtx.currentTime;
    }
    //console.log('start vs current '+this.startTime+' vs '+this.audioCtx.currentTime+' duration: '+audioBuffer.duration);
    bufferSource.buffer = audioBuffer;
    bufferSource.connect(this.gainNode);
    bufferSource.start(this.startTime);
    this.startTime += audioBuffer.duration;
    this.samples = new Float32Array();
};

