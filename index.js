import { IgApiClient, IgCheckpointError } from 'instagram-private-api';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { getMealData } from './mealData.js';
import { createCanvas, loadImage, registerFont } from 'canvas';
import inquirer from 'inquirer';
import { exec as execCb } from 'child_process';
import util from 'util';
import { EventEmitter } from 'events';

EventEmitter.defaultMaxListeners = 30;

const exec = util.promisify(execCb);
dotenv.config();

const instagram = new IgApiClient();
const IG_STATE_PATH = './.ig-state.json';
const LOG_DIR = './logs';
const LOG_FILE = path.join(LOG_DIR, 'app.log');

function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

function logLocal(message) {
  const time = new Date().toISOString();
  const line = `[${time}] ${message}\n`;
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {}
  console.log(message);
}

async function saveIgState() {
  try {
    const serialized = await instagram.state.serialize();
    delete serialized.constants;
    fs.writeFileSync(IG_STATE_PATH, JSON.stringify(serialized, null, 2), 'utf8');
  } catch {}
}

async function loadIgStateIfExists() {
  try {
    if (fs.existsSync(IG_STATE_PATH)) {
      const raw = fs.readFileSync(IG_STATE_PATH, 'utf8');
      const state = JSON.parse(raw);
      await instagram.state.deserialize(state);
      return true;
    }
  } catch {}
  return false;
}

function getDayOfWeek(yyyyMMdd) {
  const day = ['일', '월', '화', '수', '목', '금', '토'];
  const dayOfWeek = new Date(yyyyMMdd).getDay();
  return day[dayOfWeek];
}

export async function createImage(mealData, date) {
  const W = 1080;
  const H = 1920;
  registerFont('./assets/fonts/Eunjin.ttf', { family: 'Eunjin' });
  registerFont('./assets/fonts/Pretendard-Regular.ttf', { family: 'Pretendard-Regular' });
  registerFont('./assets/fonts/Pretendard-Bold.ttf', { family: 'Pretendard-Bold' });
  registerFont('./assets/fonts/Pretendard-Black.ttf', { family: 'Pretendard-Black' });
  registerFont('./assets/fonts/Pretendard-Medium.ttf', { family: 'Pretendard-Medium' });

  const image = await loadImage('./assets/backgrounds/기본.png');
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, W, H);

  const parsedDay = date.split('-');
  const text = `${parsedDay[1]}. ${parsedDay[2]}. ${getDayOfWeek(date)}`;
  ctx.textBaseline = 'top';
  ctx.font = '96px "Pretendard-Black"';
  ctx.fillStyle = '#dde7ba';
  ctx.textAlign = 'center';
  ctx.strokeStyle = '#43692f';
  ctx.lineWidth = 10;
  ctx.strokeText(text, W / 2, 100);
  ctx.fillText(text, W / 2, 100);

  const mealTypes = ['조식', '중식', '석식'];
  const colors = { title: '#43692f', text: '#43692f' };

  const normalizeMeal = (meal) => {
    if (!meal) return [];
    if (Array.isArray(meal)) return meal;
    return [];
  };

  const drawList = (items, x, startY, lineHeight, maxWidth) => {
    ctx.font = '50px "Pretendard-Medium"';
    ctx.fillStyle = colors.text;
    ctx.textAlign = 'left';
    const wrap = (line, y) => {
      const words = line.split(/\s+/);
      let cur = '';
      for (const w of words) {
        const test = cur ? cur + ' ' + w : w;
        if (ctx.measureText(test).width > maxWidth && cur) {
          ctx.fillText(cur, x, y);
          y += lineHeight;
          cur = w;
        } else {
          cur = test;
        }
      }
      if (cur) {
        ctx.fillText(cur, x, y);
        y += lineHeight;
      }
      return y;
    };
    let y = startY;
    for (const line of items) y = wrap(line, y);
    return y;
  };

  const headerX = 200;
  const listX = 430;
  const listMaxWidth = W - listX - 140;
  const headerFont = '73px "Eunjin"';
  const menuLineHeight = 70;
  let yPosition = 280;

  for (let i = 0; i < mealTypes.length; i++) {
    const raw = mealData[i];
    if (!raw) continue;
    ctx.font = headerFont;
    ctx.fillStyle = colors.title;
    ctx.textAlign = 'left';
    ctx.fillText(mealTypes[i], headerX, yPosition);
    const items = normalizeMeal(raw);
    const after = drawList(items, listX, yPosition - 10, menuLineHeight, listMaxWidth);
    yPosition = Math.max(after, yPosition + 200) + 120;
  }

  const out = fs.createWriteStream('./assets/results/meal.png');
  const stream = canvas.createPNGStream();
  stream.pipe(out);

  return new Promise((resolve, reject) => {
    out.on('finish', () => resolve());
    out.on('error', reject);
  });
}

export function getDate() {
  let date = new Date();
  let year = date.getFullYear();
  let month = ("0" + (date.getMonth() + 1)).slice(-2);
  let day = ("0" + date.getDate()).slice(-2);
  return year + "-" + month + "-" + day;
}

async function login() {
  logLocal('로그인 시도 중...');
  instagram.state.generateDevice(process.env.IG_USERNAME);
  const restored = await loadIgStateIfExists();
  if (restored) {
    try {
      await instagram.account.currentUser();
      logLocal('저장된 세션으로 로그인 성공');
      await saveIgState();
      return;
    } catch {}
  }
  try {
    logLocal('새로운 로그인 시도...');
    const auth = await instagram.account.login(process.env.IG_USERNAME, process.env.IG_PASSWORD);
  } catch (err) {
    if (err instanceof IgCheckpointError) {
      try {
        const challenge = err?.response?.body?.challenge;
        if (challenge) {
          instagram.state.checkpoint = challenge;
          instagram.state.challenge = challenge;
        }
      } catch {}
      try {
        await instagram.challenge.auto(true);
      } catch {
        try {
          await instagram.challenge.selectVerifyMethod('phone');
        } catch {
          try { await instagram.challenge.selectVerifyMethod('email'); } catch {}
        }
      }
      const envCode = process.env.IG_CHALLENGE_CODE?.trim();
      if (envCode) {
        await instagram.challenge.sendSecurityCode(envCode);
      } else {
        const { code } = await inquirer.prompt([
          { type: 'input', name: 'code', message: 'Instagram security code:' },
        ]);
        await instagram.challenge.sendSecurityCode(code);
      }
    } else {
      throw err;
    }
  }
  logLocal('로그인 완료');
  await saveIgState();
}

async function uploadImageToInstagram() {
  logLocal('인스타그램 피드 업로드 시작...');
  const parsedDay = getDate().split('-');
  const todayDate = `${parsedDay[0]}년 ${parsedDay[1]}월 ${parsedDay[2]}일 ${getDayOfWeek(getDate())}요일`;
  try {
    const imagePath = './assets/results/meal.png';
    const image = { file: fs.readFileSync(imagePath) };
    await instagram.publish.photo({
      file: image.file,
      caption: `미림마이스터고 급식\n\n${todayDate}\n#급식 #미림마이스터고`
    });
    logLocal('인스타그램 피드 업로드 성공');
    await saveIgState();
  } catch (error) {
    logLocal(`인스타그램 피드 업로드 실패: ${error.message}`);
    throw error;
  }
}

async function uploadStory() {
  logLocal('인스타그램 스토리 업로드 시작...');
  try {
    const imagePath = './assets/results/meal.png';
    const image = fs.readFileSync(imagePath);
    await instagram.publish.story({ file: image });
    logLocal('인스타그램 스토리 업로드 성공');
    await saveIgState();
  } catch (error) {
    logLocal(`인스타그램 스토리 업로드 실패: ${error.message}`);
    throw error;
  }
}

async function run() {
  const today = getDate();
  logLocal(`===== 급식 자동 업로드 시작 (${today}) =====`);
  await login();
  logLocal('급식 데이터 가져오는 중...');
  const mealData = await getMealData(today);
  if (mealData.dishName === undefined || mealData.dishName.length === 0 || mealData.dishName === '급식 정보가 없습니다.') {
    logLocal('급식 정보가 없습니다. 업로드를 건너뜁니다.');
    return;
  }
  logLocal(`급식 데이터: ${JSON.stringify(mealData.dishName)}`);
  logLocal('급식 이미지 생성 중...');
  await createImage(mealData.dishName, today);
  logLocal('급식 이미지 생성 완료');
  const uploadMode = process.env.UPLOAD_MODE;
  logLocal(`업로드 모드: ${uploadMode}`);
  if (uploadMode === 'all' || uploadMode === 'post') {
    await uploadImageToInstagram();
  }
  if (uploadMode === 'all' || uploadMode === 'story') {
    await uploadStory();
  }
  logLocal('===== 급식 자동 업로드 완료 =====');
}

async function runWithRetry(fn, delay = 60000, maxAttempts = 15) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fn();
      return;
    } catch (error) {
      logLocal(`시도 ${attempt}/${maxAttempts} 실패: ${error.message}`);
      if (error?.name === 'IgLoginRequiredError' || error?.message?.includes('login_required')) {
        logLocal('로그인 필요 - 재로그인 시도...');
        if (fs.existsSync(IG_STATE_PATH)) fs.unlinkSync(IG_STATE_PATH);
        await login();
        continue;
      }
      logLocal(`${delay / 1000}초 후 재시도...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  logLocal(`최대 시도 횟수(${maxAttempts}) 초과`);
}

logLocal('크론 스케줄러 시작 ');
cron.schedule('0 0 6 * * 1-5', async () => {
  const currentTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' });
  logLocal(`크론 작업 트리거됨 - 현재 시간: ${currentTime}`);
  await runWithRetry(run);
}, { timezone: 'Asia/Seoul' });
