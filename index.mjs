import fetch from 'node-fetch';
import * as m3u8Parser from "m3u8-parser";
import {XMLParser}  from 'fast-xml-parser';
import dayjs from 'dayjs';
import {setTimeout} from 'timers/promises';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg'

const DATE_TIME_FORMAT = 'YYYYMMDDhhmmss';
const DATE_FORMAT = 'YYYYMMDD';

// 一つのファイルの秒数
const AUDIO_FILE_SECONDS = 5;

const DOWNLOAD_DIR = 'tmp';

const getAuthenticatedHeaders = async () => {
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
  }).catch(console.error)

  // PartialKey生成
  const authHeaders = res.headers;
  const length = Number(authHeaders.get('x-radiko-keylength'))
  const offset = Number(authHeaders.get('x-radiko-keyoffset'))
  const partialkey = Buffer.from(authKey.slice(offset, offset + length)).toString('base64');

  headers['x-radiko-authtoken'] = authHeaders.get('x-radiko-authtoken')
  headers['x-radiko-partialkey'] = partialkey
  const res2 = await fetch('https://radiko.jp/v2/api/auth2', {
    method: 'GET',
    headers
  })

  return headers
}

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

const getProgramInfo = async (startAt, stationId, headers) => {

  const startDate = dayjs(startAt, DATE_TIME_FORMAT)
  // 取得する番組表の日付(番組表は5時区切りになっているので、開始時刻の五時間前の日付の番組表を取ると番組の情報がある)
  const programDate = startDate.subtract(5, 'hour')
  const programDateStr = programDate.format(DATE_FORMAT)

  // 番組表を取得
  const programList = await fetch(`https://radiko.jp/v3/program/date/${programDateStr}/JP13.xml`, {
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

const getMasterPlayList = async (stationId, startAt, endAt, seek = undefined) => {

  const params = new URLSearchParams();
  params.set('station_id', stationId);
  params.set('start_at', startAt);
  params.set('ft', startAt);
  params.set('end_at', endAt);
  params.set('to', endAt);
  if(seek != null) {
    params.set('seek', seek)
  }
  // 固定で大丈夫か?
  params.set('l', '15');
  params.set('lsid', 'a9ed540183dde886192a9095546ae668');
  params.set('type', 'b');

  return `https://tf-f-rpaa-radiko.smartstream.ne.jp/tf/playlist.m3u8?${params.toString()}`
}

const download = async (url, headers, fileName) => {
  if(!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR)
  }

  const arrayBuffer = await fetch(url, {
    method: 'GET',
    headers
  }).then(res => res.arrayBuffer()).catch(error => {
    console.error(error);
    return null;
  });
  const buffer = Buffer.from(arrayBuffer);
  const downloadPath = `${DOWNLOAD_DIR}/${fileName}`;
  if(fs.existsSync(downloadPath)) {
    // すでにあればダウンロードしない
    return ;
  }

  fs.writeFileSync(downloadPath, buffer);

}

const downloadAudioList = async (stationId, startAt, endAt, maxCount = undefined, seek = undefined) => {

  if(maxCount == null) {
    const startTime = dayjs(startAt, DATE_TIME_FORMAT);
    const endTime = dayjs(endAt, DATE_TIME_FORMAT);
    // 番組の秒数
    const totalSeconds = endTime.unix() - startTime.unix();
    maxCount = totalSeconds / AUDIO_FILE_SECONDS;
  }

  const headers = await getAuthenticatedHeaders();
  const playListUrl = await getMasterPlayList(stationId, startAt, endAt, seek);
  // m3u8ファイルが取れるので解析
  const m3u8Text = await fetch(playListUrl, {
    method: 'GET',
    headers
  }).then(res => res.text())  
  const parser = new m3u8Parser.Parser();
  parser.push(m3u8Text.split('\r\n'));
  parser.end();
  // playListの元となるuri
  const playListUri = parser.manifest.playlists[0].uri;

  for(let i = 0; i < maxCount; i++) {
    const playListUrl = `${playListUri}&_=${dayjs().valueOf()}`;
    const m3u8Text2 = await fetch(playListUrl, {
      method: 'GET',
      headers
    }).then(res => res.text());
    const parser2 = new m3u8Parser.Parser();
    parser2.push(m3u8Text2.split('\r\n'));
    parser2.end();
    // 並列ダウンロード
    await Promise.all(parser2.manifest.segments.map(seg => {
      const fileName = seg.uri.split('/').reverse()[0];
      return download(seg.uri, headers, fileName);
    }));

    await setTimeout(AUDIO_FILE_SECONDS * 1000);
  }
}

const downloadAudioListParallel = async (stationId, startAt, endAt, downloadRate = 10) => {

  // 同じ番組を複数再生するように見せかけることで、実時間よりも早くダウンロードする

  const startDateTime = dayjs(startAt, DATE_TIME_FORMAT);
  const endDateTime = dayjs(endAt, DATE_TIME_FORMAT);
  
  // 一分区切り
  const seekIntervalMinutes = 1;
  const seekList = [];
  seekList.push(undefined) // 一番目は時刻指定しないのでundefined
  let dateTime = startDateTime
  while(dateTime.isBefore(endDateTime)) {
    dateTime = dateTime.add(seekIntervalMinutes, 'minute');
    const seek = dateTime.format(DATE_TIME_FORMAT);
    seekList.push(seek);
  }
  seekList.push(endAt);

  // downloadRateずつのリストに分ける
  const partitionedSeekList = seekList.reduce((retList, seek) => {
    if(retList.length > 0 && retList[retList.length - 1].length < downloadRate) {
      const ret = retList[retList.length - 1];
      ret.push(seek);
    } else {
      retList.push([seek])
    }

    return retList;
  }, []);

  console.log(`wait ${partitionedSeekList.length} minutes.`)
  for(let list of partitionedSeekList) {
    console.log(`Audio File downloading. Period: ${list[0] ?? startAt} - ${list[list.length - 1]}`)
    const audioUrlListPromise = list.map(async seek => {
      const maxCount = seekIntervalMinutes * 60 / AUDIO_FILE_SECONDS;
      return await downloadAudioList(stationId, startAt, endAt, maxCount, seek);
    });
    await Promise.all(audioUrlListPromise);
    console.log(`Finish. Period: ${list[0] ?? startAt} - ${list[list.length - 1]}`)
  }

}

const mergeAudioFile = async (fileDirPath, outputFileName) => {

  const fileList = fs.readdirSync(fileDirPath)
  const fileText = fileList.map(file => `file '${file}'`).join('\n');
  const listFileName = `${fileDirPath}/list.txt`;
  fs.writeFileSync(listFileName, fileText);

  ffmpeg()
    .input(listFileName)
    .inputOptions(['-f concat', '-safe 0'])
    .outputOptions('-c copy')
    .output(outputFileName)
    .run();

}

const main = async (url) => {
  
  const parseResult = parseProgramUrl(url);
  if(parseResult == null) {
    // TODO log
    return null;
  }

  const headers = await getAuthenticatedHeaders();
  const program = await getProgramInfo(parseResult.startAt, parseResult.stationId, headers);

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

  console.log('Audio File downloading.');
  await downloadAudioListParallel(program.stationId, program.startAt, program.endAt);
  console.log('All Audio File downloaded.');

  // TODO とりあえずm4a固定にしたけど、ffmpegで使える拡張子に対応させる
  // ファイル名
  const startDateStr = dayjs(program.startAt, DATE_TIME_FORMAT).format('YYYY年MM月DD日')
  const outputFileName = `${program.title}_${startDateStr}.m4a`

  // ダウンロードした音声ファイルを結合させる
  mergeAudioFile(DOWNLOAD_DIR, outputFileName);
  console.log(`complete! ${path.resolve(outputFileName)}`);

}
// radikoの再生画面のURL(https://radiko.jp/#!/ts/STATION_ID/YYYYMMDDhhmmss のような)
const programUrl = process.argv[2] // TODO 決め打ちなので、修正する
main(programUrl);