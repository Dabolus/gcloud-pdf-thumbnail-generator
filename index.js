// Mostly based on this article: https://hk.saowen.com/a/6491d2206a4808f14790a93f97fb840d5095d77eae965b37b4708b5f972c741b

const { resolve } = require('path');
const { spawn } = require('child-process-promise');
const { tmpdir } = require('os');
const { unlink: unlinkCb } = require('fs');
const gs = require('gs');
const Storage = require('@google-cloud/storage');

const tmpDir = tmpdir();
const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const bucketName = process.env.BUCKET_NAME;
let bucket;

/**
 * An helper function that converts unlink callback approach to promise.
 *
 * @param {!string} path The path to unlink
 * @returns {Promise<undefined | Error>} A promise that resolves with undefined if successful,
 *                                       or to an error if unsuccessful.
 */
const unlink = (path) =>
  new Promise((resolve, reject) =>
    unlinkCb(path, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    }));

/**
 * Triggered from a change to a Cloud Storage bucket.
 *
 * @param {!Object} file The Cloud Storage file.
 */
exports.generatePDFThumbnail = async (file) => {
  bucket = bucket || new Storage({ projectId }).bucket(bucketName);
  if (file.bucket !== bucketName) {
    return;
  }
  try {
    // Divide the full path into path, file name and extension
    const [_, path, fileName, ext] = /(^.*\/)(.+)\.([^.]+)$/g.exec(file.name);
    if (ext !== 'pdf') {
      return;
    }
    const pdfPath = resolve(tmpDir, `${fileName}.${ext}`);
    const thumbPath = resolve(tmpDir, `${fileName}.jpg`);
    console.log(`Generating thumbnail for '${fileName}'...`);
    await bucket.file(file.name).download({
      destination: pdfPath,
    });
    await new Promise((resolve, reject) =>
      gs()
        .batch()
        .nopause()
        .q()
        .device('jpeg')
        .executablePath(resolve(__dirname, 'vendor/lambda-ghostscript/bin/./gs'))
        .option('-dTextAlphaBits=4')
        .option('-dFirstPage=1')
        .option('-dLastPage=1')
        .res(72)
        .input(pdfPath)
        .output(thumbPath)
        .exec((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }));
    const mogrifyProcess = await spawn('mogrify', [
      '-format', 'jpg',
      '-resize', '340x480',
      '-limit', 'area', '256MB',
      '-limit', 'memory', '256MB',
      '-limit', 'map', '512MB',
      `${fileName}.jpg`,
    ], {
      capture: ['stdout', 'stderr'],
      cwd: tmpDir,
    });
    mogrifyProcess.childProcess.kill();
    await bucket.upload(thumbPath, {
      destination: `${path}/${fileName}_thumb.jpg`,
    });
    await Promise.all([
      unlink(pdfPath),
      unlink(thumbPath),
    ]);
  } catch (e) {
    console.error(e);
  }
};
