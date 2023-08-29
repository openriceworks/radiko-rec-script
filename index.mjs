import fetch from 'node-fetch';

const authKey = "bcd151073c03b352e1ef2fd66c32209da9ca0afa";

const res = await fetch('https://radiko.jp/v2/api/auth1', {
  method: 'GET',
  headers: {
    'User-Agent': 'curl/7.52.1',
    'Accept': '*/*',
    'x-radiko-user': 'user',
    'x-radiko-app': 'pc_html5',
    'x-radiko-app-version': '0.0.1',
    'x-radiko-device': 'pc'
  }
}).catch(console.error)

// PartialKey生成
const authHeaders = res.headers;
const length = Number(authHeaders.get('x-radiko-keylength'))
const offset = Number(authHeaders.get('x-radiko-keyoffset'))
const partialkey = Buffer.from(authKey.slice(offset, offset + length)).toString('base64');

const res2 = await fetch('https://radiko.jp/v2/api/auth2', {
  method: 'GET',
  headers: {
    'User-Agent': 'curl/7.52.1',
    'Accept': '*/*',
    'x-radiko-user': 'user',
    'x-radiko-authtoken': authHeaders.get('x-radiko-authtoken'),
    'x-radiko-partialkey': partialkey,
    'x-radiko-device': 'pc'
  },
})
console.log(await res2.text())