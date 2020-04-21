'use strict';
const assert = require('assert');

const { webidlNew, promiseResolvedWith, promiseRejectedWith } = require('./helpers/webidl.js');
const { IsDetachedBuffer } = require('./abstract-ops/ecmascript.js');
const { CancelSteps, PullSteps } = require('./abstract-ops/internal-methods.js');
const { ResetQueue } = require('./abstract-ops/queue-with-sizes.js');
const aos = require('./abstract-ops/readable-streams.js');

const ReadableStreamBYOBRequestImpl = require('./ReadableStreamBYOBRequest-impl.js');

exports.implementation = class ReadableByteStreamControllerImpl {
  get byobRequest() {
    if (this._byobRequest === null && this._pendingPullIntos.length > 0) {
      const firstDescriptor = this._pendingPullIntos[0];
      const view = new Uint8Array(firstDescriptor.buffer,
                                  firstDescriptor.byteOffset + firstDescriptor.bytesFilled,
                                  firstDescriptor.byteLength - firstDescriptor.bytesFilled);

      const byobRequest = webidlNew(globalThis, 'ReadableStreamBYOBRequest', ReadableStreamBYOBRequestImpl);
      byobRequest._controller = this;
      byobRequest._view = view;
      this._byobRequest = byobRequest;
    }

    return this._byobRequest;
  }

  get desiredSize() {
    return aos.ReadableByteStreamControllerGetDesiredSize(this);
  }

  close() {
    if (this._closeRequested === true) {
      throw new TypeError('The stream has already been closed; do not close it again!');
    }

    const state = this._controlledReadableStream._state;
    if (state !== 'readable') {
      throw new TypeError(`The stream (in ${state} state) is not in the readable state and cannot be closed`);
    }

    aos.ReadableByteStreamControllerClose(this);
  }

  enqueue(chunk) {
    if (chunk.byteLength === 0) {
      throw new TypeError('chunk must have non-zero byteLength');
    }
    if (chunk.buffer.byteLength === 0) {
      throw new TypeError('chunk\'s buffer must have non-zero byteLength');
    }

    if (this._closeRequested === true) {
      throw new TypeError('stream is closed or draining');
    }

    const state = this._controlledReadableStream._state;
    if (state !== 'readable') {
      throw new TypeError(`The stream (in ${state} state) is not in the readable state and cannot be enqueued to`);
    }

    aos.ReadableByteStreamControllerEnqueue(this, chunk);
  }

  error(e) {
    aos.ReadableByteStreamControllerError(this, e);
  }

  [CancelSteps](reason) {
    if (this._pendingPullIntos.length > 0) {
      const firstDescriptor = this._pendingPullIntos[0];
      firstDescriptor.bytesFilled = 0;
    }

    ResetQueue(this);

    const result = this._cancelAlgorithm(reason);
    aos.ReadableByteStreamControllerClearAlgorithms(this);
    return result;
  }

  [PullSteps]() {
    const stream = this._controlledReadableStream;
    assert(aos.ReadableStreamHasDefaultReader(stream) === true);

    if (this._queueTotalSize > 0) {
      assert(aos.ReadableStreamGetNumReadRequests(stream) === 0);

      const entry = this._queue.shift();
      this._queueTotalSize -= entry.byteLength;

      aos.ReadableByteStreamControllerHandleQueueDrain(this);

      const view = new Uint8Array(entry.buffer, entry.byteOffset, entry.byteLength);

      return promiseResolvedWith(aos.ReadableStreamCreateReadResult(view, false, stream._reader._forAuthorCode));
    }

    const autoAllocateChunkSize = this._autoAllocateChunkSize;
    if (autoAllocateChunkSize !== undefined) {
      let buffer;
      try {
        buffer = new ArrayBuffer(autoAllocateChunkSize);
      } catch (bufferE) {
        return promiseRejectedWith(bufferE);
      }

      const pullIntoDescriptor = {
        buffer,
        byteOffset: 0,
        byteLength: autoAllocateChunkSize,
        bytesFilled: 0,
        elementSize: 1,
        ctor: Uint8Array,
        readerType: 'default'
      };

      this._pendingPullIntos.push(pullIntoDescriptor);
    }

    const promise = aos.ReadableStreamAddReadRequest(stream);

    aos.ReadableByteStreamControllerCallPullIfNeeded(this);

    return promise;
  }
};
