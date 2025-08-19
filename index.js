import { IgApiClient, IgCheckpointError } from 'instagram-private-api';
import fs from 'fs';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { getMealData } from './mealData.js';
import { createCanvas, loadImage, registerFont } from 'canvas';
import Bluebird from 'bluebird';
import inquirer from 'inquirer';

dotenv.config();

const instagram = new IgApiClient();
const IG_STATE_PATH = './.ig-state.json';

async function saveIgState() {
  try {
    const serialized = await instagram.state.serialize();
    delete serialized.constants;
    fs.writeFileSync(IG_STATE_PATH, JSON.stringify(serialized, null, 2), 'utf8');
  } catch (e) {
    console.warn('⚠️ 인스타그램 세션 저장 실패:', e?.message || e);
  }
}

async function loadIgStateIfExists() {
  try {
    if (fs.existsSync(IG_STATE_PATH)) {
      const raw = fs.readFileSync(IG_STATE_PATH, 'utf8');
      const state = JSON.parse(raw);
      await instagram.state.deserialize(state);
      return true;
    }
  } catch (e) {
    console.warn('⚠️ 인스타그램 세션 불러오기 실패, 재로그인 시도:', e?.message || e);
  }
  return false;
}

async function safePreLoginFlow() {
  try {
    await instagram.simulate.preLoginFlow();
  } catch (e) {
    console.warn('⚠️ preLoginFlow 건너뜀:', e?.message || e);
  }
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
  ctx.strokeText(text, W / 2, 190);
  ctx.fillText(text, W / 2, 190);

  const mealTypes = ['조식', '중식', '석식'];
  const colors = { title: '#43692f', text: '#43692f' };

  const normalizeMeal = (str) => {
    if (!str || typeof str !== 'string') return [];
    let s = str
      .replace(/\r\n|\r|\n/g, '\n')
      .replace(/<br\s*\/?>/gi, '\n');
    let items = s.split('\n').map(t => t.trim()).filter(Boolean);
    if (items.length <= 1) items = s.split(/[·•|/\,\-]+/).map(t => t.trim()).filter(Boolean);
  if (items.length <= 1) items = s.split(/\s+/).map(t => t.trim()).filter(Boolean);
    return items;
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
  const lineHeight = 55;
  let yPosition = 440;

  for (let i = 0; i < mealTypes.length; i++) {
    const raw = mealData[i];
    if (!raw) continue;
    ctx.font = headerFont;
    ctx.fillStyle = colors.title;
    ctx.textAlign = 'left';
    ctx.fillText(mealTypes[i], headerX, yPosition);
    const items = normalizeMeal(raw);
  const after = drawList(items, listX, yPosition - 10, lineHeight, listMaxWidth);
  yPosition = Math.max(after, yPosition + 200) + 120;
  }


  const out = fs.createWriteStream('./assets/results/meal.png');
  const stream = canvas.createPNGStream();
  stream.pipe(out);

  return new Promise((resolve, reject) => {
    out.on('finish', () => {
      console.log('✅ 이미지 생성 완료: meal.png');
      resolve();
    });
    out.on('error', reject);
  });
}

export function getDate() {
  let date = new Date();
  let year = date.getFullYear();
  let month = ("0" + (date.getMonth() + 1)).slice(-2);
  let day = ("0" + date.getDate()).slice(-2);

  let formattedDate = year + "-" + month + "-" + day;
  return formattedDate;
}

async function login() {
  instagram.state.generateDevice(process.env.IG_USERNAME);
  instagram.state.proxyUrl = process.env.IG_PROXY;

  const restored = await loadIgStateIfExists();

  if (restored) {
    try {
      await instagram.account.currentUser();
      console.log('🔐 기존 인스타그램 세션 사용');
      return;
    } catch (e) {
      console.log('ℹ️ 기존 세션이 만료되어 재로그인합니다.');
    }
  }

  await safePreLoginFlow();
  try {
    const auth = await instagram.account.login(process.env.IG_USERNAME, process.env.IG_PASSWORD);
    console.log('🔑 로그인 완료:', auth?.username || 'ok');
  } catch (err) {
    if (err instanceof IgCheckpointError) {
      console.log('🚧 체크포인트(Challenge) 발생');
      try {
        const challenge = err?.response?.body?.challenge;
        if (challenge) {
          instagram.state.checkpoint = challenge;
          instagram.state.challenge = challenge;
        }
      } catch {}
      try {
        await instagram.challenge.auto(true);
      } catch (inner) {
        console.warn('⚠️ challenge.auto 실패, 수동 코드 입력으로 진행:', inner?.message || inner);
        try {
          await instagram.challenge.selectVerifyMethod('email');
        } catch {
          try { await instagram.challenge.selectVerifyMethod('phone'); } catch {}
        }
      }

      const envCode = process.env.IG_CHALLENGE_CODE?.trim();
      if (envCode) {
        const result = await instagram.challenge.sendSecurityCode(envCode);
        console.log('✅ 보안코드 처리 결과:', result?.status || 'ok');
      } else {
        const canPrompt = process.stdout.isTTY && process.stdin.isTTY;
        if (!canPrompt) {
          throw new Error('Challenge code required. Set IG_CHALLENGE_CODE env to continue in non-interactive mode.');
        }
        console.log('📩 보안코드 입력 대기');
        const { code } = await inquirer.prompt([
          { type: 'input', name: 'code', message: 'Instagram security code:' },
        ]);
        const result = await instagram.challenge.sendSecurityCode(code);
        console.log('✅ 보안코드 처리 결과:', result?.status || 'ok');
      }
    } else {
      console.log('🛑 로그인 실패:', err?.message || err);
      throw err;
    }
  }

  await saveIgState();
  console.log('✅ 인스타그램 로그인 성공');
}

async function uploadImageToInstagram() {
  const parsedDay = getDate().split('-');
  const todayDate = `${parsedDay[0]}년 ${parsedDay[1]}월 ${parsedDay[2]}일 ${getDayOfWeek(getDate())}요일`;

  try {
    const imagePath = './assets/results/meal.png';
    const image = { file: fs.readFileSync(imagePath) };

    await instagram.publish.photo({
      file: image.file,
      caption: `미림마이스터고 급식\n\n${todayDate}\n#급식 #미림마이스터고`
    });

    console.log(`✅ 인스타그램 게시물 업로드 성공: meal.png`);
  } catch (error) {
    console.error(error);
    console.error(`🛑 게시물 업로드 오류가 났습니다`);
    throw error;
  }
}

async function uploadStory() {
  try {
    const imagePath = './assets/results/meal.png';
    const image = fs.readFileSync(imagePath);

    await instagram.publish.story({
      file: image,
    });

    console.log(`✅ 인스타그램 스토리 업로드 성공: meal.png`);
  } catch (error) {
    console.error(error);
    console.error(`🛑 스토리 업로드 오류가 났습니다`);
    throw error;
  }
}

async function run() {
  await login();

  const mealData = await getMealData(getDate());
  if (mealData.dishName === undefined || mealData.dishName.length === 0 || mealData.dishName.every(m => m.includes('급식 정보가 없습니다.'))) {
    console.log('🛑 급식 정보가 없습니다.');
    return;
  }

  await createImage(mealData.dishName, getDate());

  const uploadMode = process.env.UPLOAD_MODE;

  if (uploadMode === 'all' || uploadMode === 'post') {
    await uploadImageToInstagram();
  }
  if (uploadMode === 'all' || uploadMode === 'story') {
    await uploadStory();
  }
}

async function runWithRetry(fn, delay = 60000) {
  while (true) {
    try {
      await fn();
      break;
    } catch (error) {
      console.log(`오류 발생. 다음 재시도는 ${delay / 1000}초 후 입니다.`);
      console.log(`🛑 오류 내용: ${error}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

cron.schedule('0 0 6 * * 1-5', async () => {
// cron.schedule('0 * * * * 1-5', async () => {
  await runWithRetry(run);
});
