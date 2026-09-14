#!/usr/bin/env node
/**
 * 씨앗 세션(seed session) 헬퍼 - 인스타그램 비밀번호 로그인 없이 봇을 동작시킵니다.
 *
 * 배경: 2026년부터 Instagram 비공식 클라이언트의 /accounts/login/ 비밀번호 로그인은
 * 클라이언트 증명(CAA) 게이트 때문에 needs_upgrade 를 반환합니다. 버전 번호만 올려서는
 * 해결되지 않습니다 (그래서 index.js 의 버전 코드를 맞춰도 재로그인 시 실패).
 * 대신 이미 브라우저에서 로그인된 세션(sessionid 쿠키)을 .ig-state.json 에 심어두면
 * 봇이 비밀번호 로그인을 거치지 않고 해당 세션으로 인증합니다.
 *
 * 사용법:
 *   1) 인스타그램 웹(instagram.com)에 로그인한 상태에서 브라우저 개발자 도구(Network 탭)에서
 *      cookie 중 sessionid 값을 복사합니다. (csrftoken, ds_user_id, mid 는 있으면 같이 넣습니다.)
 *   2) 아래 실행:
 *        node seed-session.mjs
 *      또는 환경변수로 넘겨 비대화형 실행:
 *        IG_SESSIONID=... IG_CSRFTOKEN=... IG_DS_USER_ID=... node seed-session.mjs
 *   3) 봇을 다시 실행하면 "저장된 세션으로 로그인 성공" 로그와 함께 업로드가 진행됩니다.
 *
 * 이 스크립트는 /accounts/login/ 등 인스타그램 API를 전혀 호출하지 않습니다. 로컬 파일만 수정합니다.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { IgApiClient } from 'igramapi';
import dotenv from 'dotenv';

dotenv.config();

const IG_STATE_PATH = './.ig-state.json';

function log(message) {
  console.log(`[seed-session] ${message}`);
}

function missing(value) {
  return !value || !String(value).trim();
}

async function promptValue(rl, label, optional = false) {
  const v = await rl.question(label + (optional ? ' (선택, Enter로 건너뜀): ' : ': '));
  return v.trim();
}

function buildCookieEntry(key, value, httpOnly) {
  return {
    key,
    value,
    domain: 'instagram.com',
    path: '/',
    secure: true,
    httpOnly,
    hostOnly: false,
    creation: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
  };
}

function cookieStore(cookies) {
  return JSON.stringify({
    version: 'tough-cookie@4.1.4',
    storeType: 'MemoryCookieStore',
    rejectPublicSuffixes: true,
    enableLooseMode: false,
    allowSpecialUseDomain: true,
    prefixSecurity: 'silent',
    cookies,
  });
}

async function main() {
  // 1) 입력 수집
  let sessionid = process.env.IG_SESSIONID?.trim();
  let csrftoken = process.env.IG_CSRFTOKEN?.trim();
  let dsUserId = process.env.IG_DS_USER_ID?.trim();
  let mid = process.env.IG_MID?.trim();

  if (missing(sessionid) && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      log('인스타그램 브라우저 세션 정보를 입력해주세요.');
      sessionid = await promptValue(rl, 'sessionid (필수)');
      csrftoken = csrftoken || await promptValue(rl, 'csrftoken', true);
      dsUserId = dsUserId || await promptValue(rl, 'ds_user_id', true);
      mid = mid || await promptValue(rl, 'mid', true);
    } finally {
      rl.close();
    }
  }

  if (missing(sessionid)) {
    throw new Error(
      'sessionid 가 없습니다. IG_SESSIONID 환경변수를 설정하거나 대화형으로 입력하세요.\n' +
      '브라우저에서 인스타그램에 로그인한 뒤 세션 쿠키의 sessionid 값을 가져와주세요.'
    );
  }

  if (missing(dsUserId)) {
    log('경고: ds_user_id 가 없습니다. 세션 로그인이 실패할 수 있으니 함께 입력하는 것을 권장합니다.');
  }

  // sessionid 값의 오염 방지: 공백/명령어 문자열이 섞이면 거부
  if (typeof sessionid === 'string' && /\s/.test(sessionid)) {
    throw new Error(
      'sessionid 에 공백이나 명령어 텍스트가 섞여 있습니다. (예: "...DAJDg node seed-session.mjs")\n' +
      '브라우저 쿠키 값만 정확히 복사해서 다시 입력하세요.'
    );
  }
  if (typeof sessionid === 'string' && !/^\d+%3A[^ ]+/.test(sessionid)) {
    throw new Error(
      'sessionid 형식이 올바르지 않습니다. 값이 "52725565812%3As1UoMEs...%3A17" 처럼 ' +
      '숫자로 시작하고 %3A 를 포함해야 합니다.'
    );
  }

  // 2) 기존 상태 로드 (장치/신원 유지로 체크포인트 위험 최소화)
  let state = {};
  if (fs.existsSync(IG_STATE_PATH)) {
    try {
      state = JSON.parse(fs.readFileSync(IG_STATE_PATH, 'utf8'));
    } catch {
      log('기존 .ig-state.json 을 읽지 못해 새로 만듭니다.');
      state = {};
    }
  }

  if (!state.deviceId || !state.uuid) {
    log('기존 디바이스 정보가 없어 새 디바이스를 생성합니다.');
    const ig = new IgApiClient();
    await ig.state.generateDevice('_');
    const serialized = await ig.state.serialize();
    state = { ...state, ...serialized };
    state = JSON.parse(JSON.stringify(state));
    delete state.constants;
  }

  // deviceId 가 반드시 있도록 보장
  if (!state.deviceId) {
    state.deviceId = 'android-' + crypto.randomUUID().replace(/-/g, '');
  }

  const cookies = [];
  cookies.push(buildCookieEntry('sessionid', sessionid, true));
  if (csrftoken) cookies.push(buildCookieEntry('csrftoken', csrftoken, true));
  if (dsUserId) {
    cookies.push(buildCookieEntry('ds_user_id', dsUserId, false));
    state.igUserId = dsUserId;
    delete state.authorization; // 낡은 세션 토큰 제거 (세션 쿠키 기반으로 전환)
  }
  if (mid) cookies.push(buildCookieEntry('mid', mid, false));
  cookies.push(buildCookieEntry('ig_did', state.deviceId || '', false));

  state.cookies = cookieStore(cookies);

  // 3) 저장 전에 igramapi 로 복원 가능한지 확인
  try {
    const ig = new IgApiClient();
    await ig.state.deserialize(JSON.parse(JSON.stringify(state)));
    log('유효한 세션 쿠키로 복원 가능함을 확인했습니다.');
  } catch (e) {
    throw new Error(`복원 검증 실패: ${e.message}`);
  }

  fs.writeFileSync(IG_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  log(`${IG_STATE_PATH} 에 세션이 저장되었습니다. 봇(index.js)을 실행하면 세션으로 로그인합니다.`);
}

main().catch((err) => {
  console.error(`[seed-session] 오류: ${err.message}`);
  process.exit(1);
});