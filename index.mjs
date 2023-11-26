import fetch from 'node-fetch';
import {XMLParser}  from 'fast-xml-parser';
import dayjs from 'dayjs';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg'

const DATE_TIME_FORMAT = 'YYYYMMDDhhmmss';
const DATE_FORMAT = 'YYYYMMDD';
const DOWNLOAD_DIR = 'tmp';

/**
 * radikoの認証処理を行う
 * @returns 認証情報の入ったリクエストヘッダーと地方のID
 */
const authenticate = async () => {
  const authKey = "bcd151073c03b352e1ef2fd66c32209da9ca0afa";

  const headers =  {
    'User-Agent': 'curl/7.52.1',
    'Accept': '*/*',
    'x-radiko-user': 'user',
    'x-radiko-app': 'pc_html5',
    'x-radiko-app-version': '0.0.1',
    'x-radiko-device': 'pc'
  }

  const res = await fetch('https://radiko.jp/v2/api/auth1', {
    method: 'GET',
    headers
  }).catch((error) => {
    console.error(error)
    return null;
  });
  if(res == null) {
    throw new Error('authenticate failed!');
  }

  // PartialKey生成
  const authHeaders = res.headers;
  const length = Number(authHeaders.get('x-radiko-keylength'))
  const offset = Number(authHeaders.get('x-radiko-keyoffset'))
  const partialkey = Buffer.from(authKey.slice(offset, offset + length)).toString('base64');

  headers['x-radiko-authtoken'] = authHeaders.get('x-radiko-authtoken')
  headers['x-radiko-partialkey'] = partialkey
  const areaText = await fetch('https://radiko.jp/v2/api/auth2', {
    method: 'GET',
    headers
  }).then(res2 => res2.text()).catch((error) => {
    console.error(error)
    return null;
  });
  if(areaText == null) {
    throw new Error('authenticate failed!');
  }

  // areaIdのみ取り出す(areaTextは'areaId,文字列,文字列'のようなフォーマットになっている)
  const [areaId, ...rest] = areaText.split(',')

  return {
    headers,
    areaId
  }
}

/**
 * radikoの再生画面のURLをパースして、番組の情報を取得
 * @param {*} url 
 * @returns 
 */
const parseProgramUrl = (url) => {

  // radikoの再生画面のURL(https://radiko.jp/#!/ts/STATION_ID/YYYYMMDDhhmmss のような)
  const urlPattern = new RegExp('https://radiko.jp/#!/ts/([^/]+)/([0-9]{14})');

  const matchResult = url.match(urlPattern);
  if(matchResult == null) {
    return null;
  }

  return {
    stationId: matchResult[1],
    startAt: matchResult[2]
  }
}

/**
 * 音声ファイルのダウンロードに必要な番組の情報を取得する
 * @param {*} startAt 
 * @param {*} stationId 
 * @param {*} headers 
 * @param {*} areaId 
 * @returns 
 */
const getProgramInfo = async (startAt, stationId, headers, areaId) => {

  const startDate = dayjs(startAt, DATE_TIME_FORMAT)
  // 取得する番組表の日付(番組表は5時区切りになっているので、開始時刻の五時間前の日付の番組表を取ると番組の情報がある)
  const programDate = startDate.subtract(5, 'hour')
  const programDateStr = programDate.format(DATE_FORMAT)

  // 番組表を取得
  const programList = await fetch(`https://radiko.jp/v3/program/date/${programDateStr}/${areaId}.xml`, {
    method: 'GET',
    headers
  })
  const programXml = await programList.text();
  const programJson = new XMLParser({ignoreAttributes: false}).parse(programXml);
  // TODO parse失敗時はどうなる？

  const stationList = programJson?.radiko?.stations?.station ?? []
  const station = stationList.find(s => s['@_id'] === stationId) ?? null
  if(station == null) {
    return null;
  }

  const program = station?.progs?.prog?.find(item => item['@_ft'] === startAt) ?? null
  if(program == null) {
    return null
  }

  return {
    title: program['title'],
    stationId: stationId,
    startAt: program['@_ft'],
    endAt: program['@_to']
  };
}

/**
 * m3u8ファイルをダウンロードするファイルを取得する
 * @param {*} stationId 
 * @param {*} startAt 
 * @param {*} endAt 
 * @param {*} seek 
 * @returns 
 */
const getMasterPlayList = async (stationId, startAt, endAt, seek = undefined) => {

  const params = new URLSearchParams();
  params.set('station_id', stationId);
  params.set('start_at', startAt);
  params.set('ft', startAt);
  params.set('end_at', endAt);
  params.set('to', endAt);
  // 固定で大丈夫か?
  params.set('l', '15');
  params.set('lsid', 'a9ed540183dde886192a9095546ae668');
  params.set('type', 'b');

  return `https://radiko.jp/v2/api/ts/playlist.m3u8?${params.toString()}`
}


const downloadAudio = async (stationId, startAt, endAt, outputFileName) => {


  // m3u8ファイルを取得する
  // ただし、m3u8ファイルには「音声ファイルのリンク」はなく、「音声ファイルのリンクへのリンク」が記述されている。
  const { headers }= await authenticate();
  const playListUrl = await getMasterPlayList(stationId, startAt, endAt, undefined);
  console.log(`downloading. ${playListUrl}`);

  ffmpeg()
    .input(playListUrl)
    .inputOption('-headers', `X-Radiko-Authtoken: ${headers['x-radiko-authtoken']}`)
    .output(outputFileName)
    .on('end', () => {
      console.log(`finished. ${path.resolve(outputFileName)}`);
    })
    .run();
}

const main = async (url) => {
  
  const parseResult = parseProgramUrl(url);
  if(parseResult == null) {
    console.log(`unrecognized url. ${url}`)
    return null;
  }

  const {headers, areaId} = await authenticate();
  const program = await getProgramInfo(parseResult.startAt, parseResult.stationId, headers, areaId);

  if(program == null) {
    console.log(`program not found. ${url}`);
    return ;
  }
  console.log(`program found. ${program.title} (${program.startAt} - ${program.endAt})`);

  // ダウンロード用フォルダ用意
  if(fs.existsSync(DOWNLOAD_DIR)) {
    fs.rmSync(DOWNLOAD_DIR, {force: true, recursive: true})
  }
  fs.mkdirSync(DOWNLOAD_DIR);

  // ファイル名
  const startDateStr = dayjs(program.startAt, DATE_TIME_FORMAT).format('YYYY年MM月DD日')
  const outputFileName = `${DOWNLOAD_DIR}/${program.title}_${startDateStr}.wav`

  await downloadAudio(program.stationId, program.startAt, program.endAt, outputFileName)
}
// radikoの再生画面のURL(https://radiko.jp/#!/ts/STATION_ID/YYYYMMDDhhmmss のような)
const programUrl = process.argv[2] // TODO 決め打ちなので、修正する
main(programUrl);