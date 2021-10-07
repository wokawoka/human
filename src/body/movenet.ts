/**
 * MoveNet model implementation
 *
 * Based on: [**MoveNet**](https://blog.tensorflow.org/2021/05/next-generation-pose-detection-with-movenet-and-tensorflowjs.html)
 */

import { log, join } from '../util/util';
import { scale } from '../util/box';
import * as tf from '../../dist/tfjs.esm.js';
import * as coords from './movenetcoords';
import type { BodyKeypoint, BodyResult, Box, Point } from '../result';
import type { GraphModel, Tensor } from '../tfjs/types';
import type { Config } from '../config';
import { fakeOps } from '../tfjs/backend';
import { env } from '../util/env';

let model: GraphModel | null;
let inputSize = 0;
const cachedBoxes: Array<Box> = [];

let skipped = Number.MAX_SAFE_INTEGER;
const keypoints: Array<BodyKeypoint> = [];

export async function load(config: Config): Promise<GraphModel> {
  if (env.initial) model = null;
  if (!model) {
    fakeOps(['size'], config);
    model = await tf.loadGraphModel(join(config.modelBasePath, config.body.modelPath || '')) as unknown as GraphModel;
    if (!model || !model['modelUrl']) log('load model failed:', config.body.modelPath);
    else if (config.debug) log('load model:', model['modelUrl']);
  } else if (config.debug) log('cached model:', model['modelUrl']);
  inputSize = model.inputs[0].shape ? model.inputs[0].shape[2] : 0;
  if (inputSize === -1) inputSize = 256;
  return model;
}

function createBox(points): [Box, Box] {
  const x = points.map((a) => a.position[0]);
  const y = points.map((a) => a.position[1]);
  const box: Box = [
    Math.min(...x),
    Math.min(...y),
    Math.max(...x) - Math.min(...x),
    Math.max(...y) - Math.min(...y),
  ];
  const xRaw = points.map((a) => a.positionRaw[0]);
  const yRaw = points.map((a) => a.positionRaw[1]);
  const boxRaw: Box = [
    Math.min(...xRaw),
    Math.min(...yRaw),
    Math.max(...xRaw) - Math.min(...xRaw),
    Math.max(...yRaw) - Math.min(...yRaw),
  ];
  return [box, boxRaw];
}

async function parseSinglePose(res, config, image, inputBox) {
  const kpt = res[0][0];
  keypoints.length = 0;
  let score = 0;
  for (let id = 0; id < kpt.length; id++) {
    score = kpt[id][2];
    if (score > config.body.minConfidence) {
      const positionRaw: Point = [
        (inputBox[3] - inputBox[1]) * kpt[id][1] + inputBox[1],
        (inputBox[2] - inputBox[0]) * kpt[id][0] + inputBox[0],
      ];
      keypoints.push({
        score: Math.round(100 * score) / 100,
        part: coords.kpt[id],
        positionRaw,
        position: [ // normalized to input image size
          Math.round((image.shape[2] || 0) * positionRaw[0]),
          Math.round((image.shape[1] || 0) * positionRaw[1]),
        ],
      });
    }
  }
  score = keypoints.reduce((prev, curr) => (curr.score > prev ? curr.score : prev), 0);
  const bodies: Array<BodyResult> = [];
  const [box, boxRaw] = createBox(keypoints);
  const annotations: Record<string, Point[][]> = {};
  for (const [name, indexes] of Object.entries(coords.connected)) {
    const pt: Array<Point[]> = [];
    for (let i = 0; i < indexes.length - 1; i++) {
      const pt0 = keypoints.find((kp) => kp.part === indexes[i]);
      const pt1 = keypoints.find((kp) => kp.part === indexes[i + 1]);
      if (pt0 && pt1 && pt0.score > (config.body.minConfidence || 0) && pt1.score > (config.body.minConfidence || 0)) pt.push([pt0.position, pt1.position]);
    }
    annotations[name] = pt;
  }
  bodies.push({ id: 0, score, box, boxRaw, keypoints, annotations });
  return bodies;
}

async function parseMultiPose(res, config, image, inputBox) {
  const bodies: Array<BodyResult> = [];
  for (let id = 0; id < res[0].length; id++) {
    const kpt = res[0][id];
    const totalScore = Math.round(100 * kpt[51 + 4]) / 100;
    if (totalScore > config.body.minConfidence) {
      keypoints.length = 0;
      for (let i = 0; i < 17; i++) {
        const score = kpt[3 * i + 2];
        if (score > config.body.minConfidence) {
          const positionRaw: Point = [
            (inputBox[3] - inputBox[1]) * kpt[3 * i + 1] + inputBox[1],
            (inputBox[2] - inputBox[0]) * kpt[3 * i + 0] + inputBox[0],
          ];
          keypoints.push({
            part: coords.kpt[i],
            score: Math.round(100 * score) / 100,
            positionRaw,
            position: [
              Math.round((image.shape[2] || 0) * positionRaw[0]),
              Math.round((image.shape[1] || 0) * positionRaw[1]),
            ],
          });
        }
      }
      const [box, boxRaw] = createBox(keypoints);
      // movenet-multipose has built-in box details
      // const boxRaw: Box = [kpt[51 + 1], kpt[51 + 0], kpt[51 + 3] - kpt[51 + 1], kpt[51 + 2] - kpt[51 + 0]];
      // const box: Box = [Math.trunc(boxRaw[0] * (image.shape[2] || 0)), Math.trunc(boxRaw[1] * (image.shape[1] || 0)), Math.trunc(boxRaw[2] * (image.shape[2] || 0)), Math.trunc(boxRaw[3] * (image.shape[1] || 0))];
      const annotations: Record<string, Point[][]> = {};
      for (const [name, indexes] of Object.entries(coords.connected)) {
        const pt: Array<Point[]> = [];
        for (let i = 0; i < indexes.length - 1; i++) {
          const pt0 = keypoints.find((kp) => kp.part === indexes[i]);
          const pt1 = keypoints.find((kp) => kp.part === indexes[i + 1]);
          if (pt0 && pt1 && pt0.score > (config.body.minConfidence || 0) && pt1.score > (config.body.minConfidence || 0)) pt.push([pt0.position, pt1.position]);
        }
        annotations[name] = pt;
      }
      bodies.push({ id, score: totalScore, boxRaw, box, keypoints: [...keypoints], annotations });
    }
  }
  bodies.sort((a, b) => b.score - a.score);
  if (bodies.length > config.body.maxDetected) bodies.length = config.body.maxDetected;
  return bodies;
}

export async function predict(input: Tensor, config: Config): Promise<BodyResult[]> {
  if (!model || !model?.inputs[0].shape) return [];
  return new Promise(async (resolve) => {
    const t: Record<string, Tensor> = {};

    let bodies: Array<BodyResult> = [];

    if (!config.skipFrame) cachedBoxes.length = 0; // allowed to use cache or not
    skipped++;

    for (let i = 0; i < cachedBoxes.length; i++) { // run detection based on cached boxes
      t.crop = tf.image.cropAndResize(input, [cachedBoxes[i]], [0], [inputSize, inputSize], 'bilinear');
      t.cast = tf.cast(t.crop, 'int32');
      t.res = await model?.predict(t.cast) as Tensor;
      const res = await t.res.array();
      const newBodies = (t.res.shape[2] === 17) ? await parseSinglePose(res, config, input, cachedBoxes[i]) : await parseMultiPose(res, config, input, cachedBoxes[i]);
      bodies = bodies.concat(newBodies);
      Object.keys(t).forEach((tensor) => tf.dispose(t[tensor]));
    }

    if ((bodies.length !== config.body.maxDetected) && (skipped > (config.body.skipFrames || 0))) { // run detection on full frame
      t.resized = tf.image.resizeBilinear(input, [inputSize, inputSize], false);
      t.cast = tf.cast(t.resized, 'int32');
      t.res = await model?.predict(t.cast) as Tensor;
      const res = await t.res.array();
      bodies = (t.res.shape[2] === 17) ? await parseSinglePose(res, config, input, [0, 0, 1, 1]) : await parseMultiPose(res, config, input, [0, 0, 1, 1]);
      Object.keys(t).forEach((tensor) => tf.dispose(t[tensor]));
      cachedBoxes.length = 0; // reset cache
      skipped = 0;
    }

    if (config.skipFrame) { // create box cache based on last detections
      cachedBoxes.length = 0;
      for (let i = 0; i < bodies.length; i++) {
        if (bodies[i].keypoints.length > 10) { // only update cache if we detected sufficient number of keypoints
          const kpts = bodies[i].keypoints.map((kpt) => kpt.position);
          const newBox = scale(kpts, 1.5, [input.shape[2], input.shape[1]]);
          cachedBoxes.push([...newBox.yxBox]);
        }
      }
    }
    resolve(bodies);
  });
}