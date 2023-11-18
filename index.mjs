import fetch from 'node-fetch';
import * as m3u8Parser from "m3u8-parser";
import {XMLParser}  from 'fast-xml-parser';
import dayjs from 'dayjs';

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


const getMasterPlayList = async (url, headers) => {

  // TODO 全体的に存在チェック追加

  const splitUrl = url.split('/')
  const startAt = splitUrl[splitUrl.length - 1]
  const stationId = splitUrl[splitUrl.length - 2]

  const startDate = dayjs(startAt, 'YYYYMMDDhhmmss')
  // 取得する番組表の日付(番組表は5時区切りになっているので、開始時刻の五時間前の日付の番組表を取ると番組の情報がある)
  const programDate = startDate.subtract(5, 'hour')
  const programDateStr = programDate.format('YYYYMMDD')

  // 番組表を取得
  const programList = await fetch(`https://radiko.jp/v3/program/date/${programDateStr}/JP13.xml`, {
    method: 'GET',
    headers
  })
  const programXml = await programList.text();
  const programJson = new XMLParser({ignoreAttributes: false}).parse(programXml);

  const stationList = programJson['radiko']['stations']['station']
  const station = stationList.find(s => s['@_id'] === stationId)
  const program = station.progs.prog.find(item => item['@_ft'] === startAt)

  const params = new URLSearchParams();
  params.set('station_id', "LFR");
  params.set('start_at', startAt);
  params.set('ft', startAt);
  params.set('end_at', program['@_to']);
  params.set('to', program['@_to']);
  // 固定で大丈夫か?
  params.set('l', '15');
  params.set('lsid', 'a9ed540183dde886192a9095546ae668');
  params.set('type', 'b');

  return `https://tf-f-rpaa-radiko.smartstream.ne.jp/tf/playlist.m3u8?${params.toString()}`
}

const main = async (url) => {

  const headers = await getAuthenticatedHeaders();

  const playlistUrl = await getMasterPlayList(url);

    // m3u8ファイルが取れるので解析
  const m3u8Text = await fetch(playlistUrl, {
    method: 'GET',
    headers
  }).then(res => res.text())  
  const parser = new m3u8Parser.Parser();
  parser.push(m3u8Text.split('\r\n'));
  parser.end();
  // playListの元となるuri
  const playListUri = parser.manifest.playlists[0].uri;

  // TODO ここら辺の処理はライブラリで何とかならないのか？
  // 音声ファイルへのリンクが書かれたm3u8ファイルを取得する
  // playListUrlに現在時刻(unixtime)を追加
  const playListUrl = `${playListUri}&_=${dayjs().unix()}`;
  const m3u8Text2 = await fetch(playListUrl, {
    method: 'GET',
    headers
  }).then(res => res.text());
  const parser2 = new m3u8Parser.Parser();
  parser2.push(m3u8Text2.split('\r\n'));
  parser2.end();
  console.log(parser2.manifest.segments)

}

// radikoの再生画面のURL(https://radiko.jp/#!/ts/STATION_ID/YYYYMMDDhhmmss のような)
const programUrl = '';
main(programUrl);