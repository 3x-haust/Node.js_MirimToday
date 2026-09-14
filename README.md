<div align="center">매일 인스타그램에 급식 올려주는 프로그램</div>  

# Contents
* [Feature](#Feature) <br/>
* [Stack](#Stack)

### Feature

* `Upload` - Instagram에 급식 업로드
* `Discord` - 봇 Command로 급식 정보 확인

---
### Stack

* `JavaScript (Node.js, Discord.js)` - Insagram에 업로드, Discord 봇 커맨드
* `IDE` - Visual Studio Code
* `VCS`- Git, GitHub

---
<a href="https://instagram.com/mirim_today">
    <img 
        src="http://img.shields.io/badge/-Instagram-black?style=flat&logo=Instagram&link=https://instagram.com/mirim_today/"
        style="height : auto; margin-left : 10px; margin-right : 10px;"/>
</a>
<br />

> **@mirim_today** - 인스타그램

---
### Instagram 업로드 (instagrapi 워커 + 세션 방식)

2026년부터 Instagram은 비공식 JS 클라이언트(`igramapi`)의 `/accounts/login/` 로그인에 클라이언트 증명(CAA)을 요구해 더는 로그인이 불가능합니다(버전만으로는 해결 안 됨, `needs_upgrade`). 그래서 업로드 레이어만 CAA/세션 바인딩을 자동 처리하는 **Python instagrapi** 워커(`ig_post.py`)로 위임했습니다. 인증은 브라우저에서 받아온 세션 `sessionid` 쿠키를 사용합니다.

준비(1회):
```
python3 -m venv .venv
.venv/bin/pip install instagrapi
```

세션 시드:
1. `instagram.com`에 로그인한 브라우저에서 관리자 도구(Application → Cookies → https://www.instagram.com)로 `sessionid`(그리고 `csrftoken`, `ds_user_id`, `mid`) 쿠키 값을 복사합니다.
2. 의미를 심습니다(대화형 또는 환경변수). 값에 명령어/공백이 섞이면 오류로 거부합니다.
   ```
   node seed-session.mjs
   # 또는:
   IG_SESSIONID=... IG_CSRFTOKEN=... IG_DS_USER_ID=... IG_MID=... node seed-session.mjs
   ```
3. 봇을 실행하면 업로드 시 `ig_post.py`가 세션으로 인증 후 게시합니다.

`seed-session.mjs`와 `ig_post.py`는 로컬 파일만 사용합니다. 세션이 만료되면 2번을 다시 하면 됩니다.
