#!/usr/bin/env node

const { optimizeROI } = require('./optimization/optimizeROI');

const { writeFileSync, existsSync, mkdirSync } = require('fs');
const { resolve } = require('path');
const { argv } = require('yargs');
const { xyExtract, xMinMaxValues, xMedian } = require('ml-spectra-processing');
const { generateSpectrum } = require('spectrum-generator');
const { isAnyArray } = require('is-any-array');
const { xyAutoRangesPicking } = require('nmr-processing');
const { fileListFromPath } = require('filelist-utils');
const { convertFileList, groupByExperiments } = require('brukerconverter');
const { converterOptions, getName, groupExperiments } = require('./options');

(async () => {
  // const path = '/nmr/IVDR02/data/covid19_heidelberg_URI_NMR_URINE_IVDR02_COVp93_181121';
  // let path = '/home/abolanos/spectraTest/covid19_heidelberg_URI_NMR_URINE_IVDR02_COVp93_181121';
  // const pathToWrite = '/home/abolanos/result_peakpicking_fit4';

  const {
    path = resolve('./data'),
    pathToWrite = resolve('../results'),
  } = argv;

  if (!existsSync(pathToWrite)) {
    mkdirSync(pathToWrite);
  }

  const fileList = fileListFromPath(path);
  const tempExperiments = groupByExperiments(fileList, converterOptions.filter);
  const experiments = tempExperiments.filter((exp) => exp.expno % 10 === 0);

  const groupsOfExperiments = groupExperiments(experiments);

  for (const goe of groupsOfExperiments) {
    const groupFileList = [];
    for (const experiment of goe) {
      groupFileList.push(...experiment.fileList);
    }

    const data = await convertFileList(groupFileList, converterOptions);
    for (let i = 0; i < data.length; i++) {
      const frequency = data[i].meta.SF;
      const name = getName(data[i]);
      let spectrum = data[i].spectra[0].data;
      if (spectrum.x[0] > spectrum.x[1]) {
        spectrum.x = spectrum.x.reverse();
        spectrum.re = spectrum.re.reverse();
      }

      const xyData = { x: spectrum.x, y: spectrum.re };

      await process({ xyData, name, pathToWrite, frequency })
    }
  }
})()

function process(options) {
  const { xyData, name, pathToWrite, frequency } = options;

  const fromTo = { from: 6.27, to: 6.315 };

  const experimental = xyExtract(xyData, {
    zones: [fromTo],
  });

  const medianOfAll = xMedian(xyData.y);
  const medianOfROI = xMedian(xyExtract(xyData, {
    zones: [{ from: 6.2, to: 6.4 }],
  }).y);

  if (medianOfAll * 3 > medianOfROI) return;
  const ranges = xyAutoRangesPicking(experimental, { peakPicking: { frequency }, ranges: { keepPeaks: true, compile: false, joinOverlapRanges: false, frequencyCluster: 6 } });
  console.log(ranges.length, ranges.map(e => e.from), medianOfAll, medianOfROI, name);
  if (ranges.length === 0) return;
  console.log(ranges[ranges.length - 1].signals.reduce((nbPeaks, signal) => {
    return nbPeaks + signal.peaks.length;
  }, 0), ranges[ranges.length - 1].signals[0].peaks.length)

  const { rangeIndex, signalIndex, peakIndex } = getBiggestPeak(ranges);

  const peaksCloseToBiggest = ranges[rangeIndex].signals[signalIndex].peaks
  const biggestPeak = ranges[rangeIndex]?.signals[signalIndex]?.peaks[peakIndex];
  const x1Limits = {
    min: biggestPeak
      ? biggestPeak.x
      : (ranges[ranges.length - 1].from + ranges[ranges.length - 1].to) / 2,
    max: biggestPeak
      ? peakIndex < peaksCloseToBiggest.length - 1
        ? peaksCloseToBiggest[peakIndex + 1].x
        : biggestPeak.x + biggestPeak.width / frequency * 2
      : biggestPeak.x,
    gradientDifference: 0.0001
  }
  const x2Limits = {
    min: biggestPeak
      ? peakIndex > 0
        ? peaksCloseToBiggest[peakIndex - 1].x
        : biggestPeak.x - biggestPeak.width / frequency * 2
      : ranges[ranges.length - 1].from,
    max: biggestPeak
      ? biggestPeak.x
      : (ranges[ranges.length - 1].from + ranges[ranges.length - 1].to) / 2,
    gradientDifference: 0.0001
  }
  console.log(x1Limits, x2Limits);
  const minMaxY = xMinMaxValues(experimental.y);
  const range = minMaxY.max - minMaxY.min;
  minMaxY.range = range;
  const normalized = experimental.y.map((e) => e / range);

  const js = 2.34 / frequency; // in Hz

  const widthGuess = 0.97 / frequency; //in Hz
  const signals = [
    {
      x: 6.290,
      y: 1,
      coupling: js,
      pattern: [{ x: -js / 2, y: 1 }, { x: js / 2, y: 1 }],
      parameters: {
        x: x1Limits,
        y: {
          min: 0,
          max: 1,
          gradientDifference: 0.001
        },
        fwhm: {
          min: widthGuess / 2,
          max: widthGuess * 1.2,
        },
        coupling: {
          min: js * 0.9,
          max: js * 1.2,
        }
      }
    },
    {
      x: 6.283,
      y: 0.5,
      coupling: js,
      pattern: [{ x: -js / 2, y: 1 }, { x: js / 2, y: 1 }],
      parameters: {
        x: x2Limits,
        y: {
          min: 0,
          max: 1,
          gradientDifference: 0.001
        },
        fwhm: {
          min: widthGuess / 2,
          max: widthGuess * 1.2,
        },
        coupling: {
          min: js * 0.8,
          max: js * 1.2,
        }
      }
    },
  ];
  // console.log(signals[0].parameters.x)
  // return
  const tempSignals = optimizeROI({ x: experimental.x, y: normalized }, signals, {
    baseline: 0,
    shape: { kind: 'gaussian' },
    optimization: {
      kind: 'direct',
      options: {
        iterations: 10,
      }
    }
  });
  tempSignals.forEach((signal, i, arr) => {
    const fwhm = signal.shape.fwhm;
    console.log(signal)
    arr[i].shape = {
      kind: 'pseudoVoigt',
      fwhm,
      mu: 0,
    }
  });
  const newSignals = optimizeROI({ x: experimental.x, y: normalized }, tempSignals, {
    baseline: 0,
    optimization: {
      kind: 'lm',
      options: {
        maxIterations: 2000,
      }
    }
  });

  // writeFileSync('signals.json', JSON.stringify(newSignals));
  const peaks = newSignals.flatMap((signal) => {
    const { x: delta, y: intensity, coupling, pattern } = signal;
    delete signal.pattern;
    const halfCoupling = coupling / 2;
    return pattern.map((peak) => {
      const { x, y } = peak;
      return {
        ...signal,
        x: delta + (x / Math.abs(x) * halfCoupling),
        y: intensity * y,
      }
    })
  })

  peaks.forEach((peak, i, arr) => {
    arr[i].y *= range;
  })

  newSignals.forEach((_, i, arr) => {
    arr[i].y *= range;
  });

  const fit = generateSpectrum(peaks, { generator: { nbPoints: experimental.x.length, ...fromTo } })
  const residual = experimental.y.map((e, i) => e - fit.y[i]);
  writeFileSync(join(pathToWrite, `${name}_FIT.json`), JSON.stringify([{
    name,
    expno: 'null',
    fit: [
      {
        roi: fromTo,
        fit: Array.from(fit.y),
        residual: Array.from(residual),
        peaks: [],
        optimizedPeaks: peaks,
        signals: newSignals
      }
    ],
    xyData: ensureArray(experimental),
    frequency
  }]));
}

function ensureArray(obj) {
  let result;
  if (isAnyArray(obj)) {
    result = obj.map((arr) => Array.from(arr));
  } else {
    result = {};
    for (let key in obj) {
      if (isAnyArray(obj[key])) {
        result[key] = Array.from(obj[key]);
      } else {
        result[key] = obj[key];
      }
    }
  }

  return result;
}

function getBiggestPeak(ranges) {
  let indices = { rangeIndex: -1, signalIndex: -1, peakIndex: -1 };
  let max = Number.MIN_SAFE_INTEGER;
  for (let i = 0; i < ranges.length; i++) {
    const signals = ranges[i].signals;
    for (let j = 0; j < signals.length; j++) {
      const peaks = signals[j].peaks;
      for (let k = 0; k < peaks.length; k++) {
        const peak = peaks[k];
        if (peak.y > max) {
          max = peak.y;
          indices =
            { rangeIndex: i, signalIndex: j, peakIndex: k }
        }
      }
    }
  }
  return indices;
}