import { IgApiClient, IgCheckpointError, IgLoginTwoFactorRequiredError } from 'igramapi';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { getMealData } from './mealData.js';
import { createCanvas, loadImage, registerFont } from 'canvas';
import inquirer from 'inquirer';
import { exec as execCb, execFile as execFileCb } from 'child_process';
import util from 'util';
import { EventEmitter } from 'events';

EventEmitter.defaultMaxListeners = 30;

const exec = util.promisify(execCb);
const execFile = util.promisify(execFileCb);
dotenv.config();

const instagram = new IgApiClient();

const IG_APP_VERSION = process.env.IG_APP_VERSION?.trim() || '446.0.0.49.77';
const IG_APP_VERSION_CODE = process.env.IG_APP_VERSION_CODE?.trim() || '385211303';
const IG_PYTHON = process.env.IG_PYTHON?.trim() || './.venv/bin/python';
const IG_POST_SCRIPT = './ig_post.py';

function applyInstagramAppVersion() {
  const constants = instagram?.state?.constants;

  if (!constants) {
    logLocal('Instagram 앱 버전 override 실패: state.constants를 찾을 수 없습니다.');
    return;
  }

  constants.APP_VERSION = IG_APP_VERSION;
  constants.APP_VERSION_CODE = IG_APP_VERSION_CODE;

  logLocal(`Instagram 앱 버전 override: ${IG_APP_VERSION} (${IG_APP_VERSION_CODE})`);
}
const IG_STATE_PATH = './.ig-state.json';
const LOG_DIR = './logs';
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const JOB_LOCK_PATH = './.job.lock';
const JOB_LOCK_STALE_MS = Number(process.env.JOB_LOCK_STALE_MS || 2 * 60 * 60 * 1000);
const CRON_EXPRESSION = process.env.CRON_SCHEDULE?.trim() || '0 6 * * 1-5';
const CRON_TIMEZONE = process.env.CRON_TIMEZONE?.trim() || 'Asia/Seoul';
let isJobRunning = false;

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

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function getErrorBody(error) {
  const body = error?.response?.body;
  if (!body) return '';
  const raw = typeof body === 'string' ? body : safeStringify(body);
  return raw
    .replace(/("two_factor_identifier"\s*:\s*")[^"]+(")/g, '$1[REDACTED]$2')
    .replace(/("trusted_notification_polling_nonce"\s*:\s*")[^"]+(")/g, '$1[REDACTED]$2')
    .replace(/("verification_code"\s*:\s*")[^"]+(")/g, '$1[REDACTED]$2');
}

function summarizeError(error) {
  if (!error) return 'Unknown error';
  const statusCode = error?.response?.statusCode;
  const message = String(error?.message || '').trim();
  const bodyText = getErrorBody(error);
  const parts = [];
  if (message) parts.push(message);
  if (statusCode) parts.push(`status=${statusCode}`);
  if (bodyText) parts.push(`body=${bodyText}`);
  return parts.join(' | ') || String(error);
}

function isCheckpointError(error) {
  const message = String(error?.message || '');
  const name = String(error?.name || '');
  const bodyMessage = String(error?.response?.body?.message || '');
  const bodyText = getErrorBody(error);
  const token = `${message} ${name} ${bodyMessage} ${bodyText}`.toLowerCase();

  return (
    error instanceof IgCheckpointError ||
    token.includes('checkpoint_required') ||
    token.includes('challenge_required')
  );
}

function isLoginRequiredError(error) {
  const token = `${String(error?.name || '')} ${String(error?.message || '')} ${getErrorBody(error)}`.toLowerCase();
  return token.includes('igloginrequirederror') || token.includes('login_required');
}

function isRateLimitedError(error) {
  const token = `${String(error?.name || '')} ${String(error?.message || '')} ${getErrorBody(error)}`.toLowerCase();
  const statusCode = Number(error?.response?.statusCode || 0);
  return (
    statusCode === 429 ||
    token.includes('please wait a few minutes') ||
    token.includes('rate_limit') ||
    token.includes('sentry_block') ||
    token.includes('feedback_required')
  );
}

function isTwoFactorRequiredError(error) {
  const token = `${String(error?.name || '')} ${String(error?.message || '')} ${getErrorBody(error)}`.toLowerCase();
  return (
    error instanceof IgLoginTwoFactorRequiredError ||
    error?.response?.body?.two_factor_required === true ||
    token.includes('two_factor_required')
  );
}

function isInvalidTwoFactorCodeError(error) {
  const token = `${String(error?.name || '')} ${String(error?.message || '')} ${getErrorBody(error)}`.toLowerCase();
  return (
    token.includes('invalid_verficaition_code') ||
    token.includes('invalid_verification_code') ||
    token.includes('please check the security code and try again')
  );
}

function resolveTwoFactorVerificationMethod(twoFactorInfo) {
  if (process.env.IG_2FA_METHOD?.trim()) return process.env.IG_2FA_METHOD.trim();
  if (twoFactorInfo?.totp_two_factor_on) return '3';
  return '1';
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJobLock() {
  try {
    if (!fs.existsSync(JOB_LOCK_PATH)) return null;
    return JSON.parse(fs.readFileSync(JOB_LOCK_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function acquireJobLock() {
  const lockData = { pid: process.pid, startedAt: Date.now() };
  try {
    fs.writeFileSync(JOB_LOCK_PATH, JSON.stringify(lockData), { encoding: 'utf8', flag: 'wx' });
    return { acquired: true, reason: 'new' };
  } catch (error) {
    if (error?.code !== 'EEXIST') return { acquired: false, reason: 'write_failed' };
  }

  const existing = readJobLock();
  if (!existing) return { acquired: false, reason: 'locked' };

  const isStale = Date.now() - Number(existing.startedAt || 0) > JOB_LOCK_STALE_MS;
  const alive = isProcessAlive(Number(existing.pid));
  if (!alive || isStale) {
    try {
      fs.unlinkSync(JOB_LOCK_PATH);
      fs.writeFileSync(JOB_LOCK_PATH, JSON.stringify(lockData), { encoding: 'utf8', flag: 'wx' });
      return { acquired: true, reason: !alive ? 'orphan_recovered' : 'stale_recovered' };
    } catch {
      return { acquired: false, reason: 'recover_failed' };
    }
  }
  return { acquired: false, reason: `held_by_pid_${existing.pid}` };
}

function releaseJobLock() {
  try {
    const existing = readJobLock();
    if (!existing) return;
    if (Number(existing.pid) === process.pid) fs.unlinkSync(JOB_LOCK_PATH);
  } catch {}
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
  const date = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })
  );
  const year = date.getFullYear();
  const month = ("0" + (date.getMonth() + 1)).slice(-2);
  const day = ("0" + date.getDate()).slice(-2);
  return `${year}-${month}-${day}`;
}

async function login() {
  logLocal('로그인 시도 중...');
  applyInstagramAppVersion();
  instagram.state.generateDevice(process.env.IG_USERNAME);
  const restored = await loadIgStateIfExists();
  if (restored) {
    try {
      await instagram.account.currentUser();
      logLocal('저장된 세션으로 로그인 성공');
      await saveIgState();
      return;
    } catch (restoreErr) {
      logLocal(`저장된 세션 인증 실패: ${summarizeError(restoreErr)}`);
    }
  }
  try {
    logLocal('새로운 로그인 시도...');
    await instagram.simulate.preLoginFlow();
    await instagram.account.login(process.env.IG_USERNAME, process.env.IG_PASSWORD);
    process.nextTick(async () => {
      try {
        await instagram.simulate.postLoginFlow();
      } catch {}
    });
  } catch (err) {
    if (isTwoFactorRequiredError(err)) {
      const twoFactorInfo = err?.response?.body?.two_factor_info || {};
      const twoFactorIdentifier = twoFactorInfo?.two_factor_identifier;
      const username = twoFactorInfo?.username || process.env.IG_USERNAME;
      const verificationMethod = resolveTwoFactorVerificationMethod(twoFactorInfo);
      const channelHint = twoFactorInfo?.obfuscated_phone_number_2 || twoFactorInfo?.obfuscated_phone_number || '';
      const maxTwoFactorAttempts = Number(process.env.IG_TWO_FACTOR_MAX_ATTEMPTS || 3);
      if (!twoFactorIdentifier || !username) {
        throw new Error(`two_factor_required: 식별자 정보가 없습니다. ${summarizeError(err)}`);
      }

      logLocal(`2단계 인증 필요 (method=${verificationMethod === '3' ? 'TOTP' : 'SMS'}${channelHint ? `, 대상=${channelHint}` : ''})`);
      const env2faCode = (process.env.IG_TWO_FACTOR_CODE?.trim() || process.env.IG_2FA_CODE?.trim())?.replace(/[\s\-]/g, '');
      let loginSuccess = false;
      for (let attempt = 1; attempt <= maxTwoFactorAttempts; attempt++) {
        let verificationCode = env2faCode;

        if (verificationCode) {
          logLocal('환경변수 IG_TWO_FACTOR_CODE/IG_2FA_CODE로 2FA 코드를 사용합니다.');
        } else if (process.stdin.isTTY) {
          const { code } = await inquirer.prompt([
            {
              type: 'input',
              name: 'code',
              message: verificationMethod === '3' ? 'Instagram Authenticator(TOTP) code:' : 'Instagram SMS code:',
            },
          ]);
          verificationCode = String(code || '').trim();
        } else {
          throw new Error('two_factor_required: 대화형 입력이 불가능합니다. IG_TWO_FACTOR_CODE(또는 IG_2FA_CODE)를 설정하세요.');
        }

        if (!verificationCode) {
          throw new Error('two_factor_required: 입력된 2FA 코드가 비어 있습니다.');
        }

        try {
          await instagram.account.twoFactorLogin({
            username,
            verificationCode,
            twoFactorIdentifier,
            verificationMethod,
            trustThisDevice: '1',
          });
          loginSuccess = true;
          break;
        } catch (twoFactorErr) {
          if (!isInvalidTwoFactorCodeError(twoFactorErr)) throw twoFactorErr;
          if (env2faCode) {
            throw new Error(`two_factor_required: 환경변수 코드가 유효하지 않습니다. ${summarizeError(twoFactorErr)}`);
          }
          if (attempt >= maxTwoFactorAttempts) {
            throw new Error(`two_factor_required: 코드 확인 실패(${attempt}/${maxTwoFactorAttempts}). ${summarizeError(twoFactorErr)}`);
          }
          logLocal(`2FA 코드 불일치 (${attempt}/${maxTwoFactorAttempts}) - 최신 SMS 코드를 다시 입력하세요.`);
        }
      }

      if (!loginSuccess) {
        throw new Error('two_factor_required: 2FA 로그인에 실패했습니다.');
      }

      process.nextTick(async () => {
        try {
          await instagram.simulate.postLoginFlow();
        } catch {}
      });
    } else if (!isCheckpointError(err)) {
      logLocal(`로그인 실패 상세: ${summarizeError(err)}`);
      throw err;
    } else {
      logLocal(`checkpoint/challenge 감지: ${summarizeError(err)}`);
      logLocal('본인확인 절차를 시도합니다.');
      try {
        const challenge = err?.response?.body?.challenge;
        if (challenge) {
          instagram.state.checkpoint = challenge;
          instagram.state.challenge = challenge;
        }
      } catch {
        // noop
      }

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
        logLocal('환경변수 IG_CHALLENGE_CODE로 보안코드 제출 완료');
      } else if (process.stdin.isTTY) {
        const { code } = await inquirer.prompt([
          { type: 'input', name: 'code', message: 'Instagram security code:' },
        ]);
        await instagram.challenge.sendSecurityCode(code);
      } else {
        throw new Error('checkpoint_required: 대화형 입력이 불가능합니다. 인스타 앱에서 본인확인을 완료하거나 IG_CHALLENGE_CODE를 설정하세요.');
      }
    }
  }
  await instagram.account.currentUser();
  logLocal('로그인 완료');
  await saveIgState();
}

async function runIgUpload(mode, caption = '') {
  const { stdout, stderr } = await execFile(IG_PYTHON, [IG_POST_SCRIPT, '--image', './assets/results/meal.png', '--mode', mode], {
    cwd: process.cwd(),
    env: { ...process.env, IG_CAPTION: caption },
    maxBuffer: 20 * 1024 * 1024,
  });
  const out = (stdout || '').trim() || (stderr || '').trim();
  if (out) logLocal(out);
}

async function uploadImageToInstagram() {
  logLocal('인스타그램 피드 업로드 시작...');
  const parsedDay = getDate().split('-');
  const todayDate = `${parsedDay[0]}년 ${parsedDay[1]}월 ${parsedDay[2]}일 ${getDayOfWeek(getDate())}요일`;
  try {
    await runIgUpload('feed', `미림마이스터고 급식\n\n${todayDate}\n#급식 #미림마이스터고`);
    logLocal('인스타그램 피드 업로드 성공');
  } catch (error) {
    logLocal(`인스타그램 피드 업로드 실패: ${summarizeError(error)}`);
    throw error;
  }
}

async function uploadStory() {
  logLocal('인스타그램 스토리 업로드 시작...');
  try {
    await runIgUpload('story');
    logLocal('인스타그램 스토리 업로드 성공');
  } catch (error) {
    logLocal(`인스타그램 스토리 업로드 실패: ${summarizeError(error)}`);
    throw error;
  }
}

async function run() {
  const today = getDate();
  logLocal(`===== 급식 자동 업로드 시작 (${today}) =====`);
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
  const throttleDelay = Number(process.env.IG_THROTTLE_DELAY_MS || 10 * 60 * 1000);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fn();
      return;
    } catch (error) {
      logLocal(`시도 ${attempt}/${maxAttempts} 실패: ${summarizeError(error)}`);
      if (isTwoFactorRequiredError(error)) {
        logLocal('2단계 인증 필요 - 코드 입력/설정 후 다시 실행하세요.');
        throw error;
      }
      if (isInvalidTwoFactorCodeError(error)) {
        logLocal('2FA 코드가 올바르지 않습니다. 반복 재시도하지 않고 종료합니다.');
        throw error;
      }
      if (isCheckpointError(error)) {
        logLocal('checkpoint_required 감지 - 반복 재시도를 중단합니다. 인스타 앱에서 본인확인을 완료한 뒤 다시 실행하세요.');
        throw error;
      }
      if (isRateLimitedError(error)) {
        logLocal(`로그인/요청 제한 감지 - ${Math.floor(throttleDelay / 1000)}초 대기 후 재시도합니다.`);
        await new Promise(resolve => setTimeout(resolve, throttleDelay));
        continue;
      }
      if (isLoginRequiredError(error)) {
        logLocal('로그인 필요 - 재로그인 시도...');
        if (fs.existsSync(IG_STATE_PATH)) fs.unlinkSync(IG_STATE_PATH);
        await login();
        continue;
      }
      logLocal(`${delay / 1000}초 후 재시도...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  const maxRetryError = new Error(`최대 시도 횟수(${maxAttempts}) 초과`);
  logLocal(maxRetryError.message);
  throw maxRetryError;
}

logLocal(`크론 스케줄러 시작 (표현식: ${CRON_EXPRESSION}, 타임존: ${CRON_TIMEZONE})`);
cron.schedule(CRON_EXPRESSION, async () => {
  if (isJobRunning) {
    logLocal('이전 작업이 아직 실행 중이라 이번 크론 트리거를 건너뜁니다.');
    return;
  }

  const lock = acquireJobLock();
  if (!lock.acquired) {
    logLocal(`다른 프로세스가 작업 중이라 이번 크론 트리거를 건너뜁니다. (${lock.reason})`);
    return;
  }

  isJobRunning = true;
  const currentTime = new Date().toLocaleString('en-US', { timeZone: CRON_TIMEZONE });
  logLocal(`크론 작업 트리거됨 - 현재 시간: ${currentTime}`);
  await runWithRetry(run);
}, { timezone: 'Asia/Seoul' });
