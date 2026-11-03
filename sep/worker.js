'use strict';
// Отделение голоса в отдельном потоке, чтобы окно не подвисало: модель HTDemucs через onnxruntime.
// На Windows считает видеокарта (DirectML, любая с DirectX 12), иначе процессор.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const ort = require('onnxruntime-node');
const { DemucsProcessor } = require('./demucs.js');

const GPU = { executionProviders: ['dml'], enableMemPattern: false, executionMode: 'sequential', graphOptimizationLevel: 'all' };
const CPU = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' };

(async () => {
  try {
    const { model, left, right } = workerData;
    const buf = fs.readFileSync(model);
    const proc = new DemucsProcessor({ ort, onProgress: ({ progress }) => parentPort.postMessage({ p: progress }) });
    const opts = process.platform === 'win32' ? [GPU, CPU] : [CPU];
    let r = null;
    for (const o of opts) {
      try {
        proc.session = await ort.InferenceSession.create(buf, o);
        parentPort.postMessage({ gpu: o === GPU });
        r = await proc.separate(left, right);
        break;
      } catch (e) {
        if (o === opts[opts.length - 1]) throw e; // видеокарта не справилась — пробуем процессором
      }
    }
    // минус = всё, кроме голоса; голос отдельно (по нему точнее распознаются слова)
    const n = left.length, iL = new Float32Array(n), iR = new Float32Array(n), vox = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      iL[i] = r.drums.left[i] + r.bass.left[i] + r.other.left[i];
      iR[i] = r.drums.right[i] + r.bass.right[i] + r.other.right[i];
      vox[i] = (r.vocals.left[i] + r.vocals.right[i]) / 2;
    }
    parentPort.postMessage({ done: true, out: { iL, iR, vox } }, [iL.buffer, iR.buffer, vox.buffer]);
  } catch (e) {
    parentPort.postMessage({ err: String((e && e.message) || e) });
  }
})();
