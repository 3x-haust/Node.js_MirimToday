#!/usr/bin/env python3
"""Instagram 업로드 워커 (instagrapi 기반). igramapi 는 인스타그램의 CAA 게이트로 더는 로그인 불가.

호출: .venv/bin/python ig_post.py --image <경로> [--caption <텍스트>]  (UPLOAD_MODE=story/post)
세션: .ig-state.json 의 sessionid 우선, 없으면 IG_SESSIONID 환경변수. 성공 0 / 실패 non-zero.
"""
import argparse
import json
import os
import sys


def load_sessionid() -> str:
    s = os.environ.get("IG_SESSIONID", "").strip()
    if s:
        return s
    state_path = os.environ.get("IG_SESSIONID_FILE", "").strip()
    if not state_path:
        runtime = os.environ.get("RUNTIME_DIR", "").strip() or "."
        state_path = os.path.join(runtime, ".ig-state.json")
    try:
        with open(state_path, "r", encoding="utf-8") as f:
            state = json.load(f)
        cookies = json.loads(state.get("cookies", "{}"))
        for c in cookies.get("cookies", []):
            if c.get("key") == "sessionid" and c.get("value"):
                return c["value"]
    except Exception:
        pass
    return ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--caption", default=os.environ.get("IG_CAPTION", ""))
    parser.add_argument("--mode", default=os.environ.get("UPLOAD_MODE", "story"))
    args = parser.parse_args()

    username = os.environ.get("IG_USERNAME", "").strip()
    if not username:
        print("오류: IG_USERNAME 이 없습니다.")
        return 10

    sessionid = load_sessionid()
    if not sessionid:
        print("오류: sessionid 가 없습니다. .ig-state.json 을 시드하거나 IG_SESSIONID 를 설정하세요.")
        return 11

    try:
        from instagrapi import Client
    except Exception as exc:
        print(f"오류: instagrapi 없음 (.venv/bin/pip install instagrapi). {exc}")
        return 12

    cl = Client()
    cl.delay_range = [1, 3]
    try:
        cl.login_by_sessionid(sessionid)
    except Exception as exc:
        print(f"오류: 세션 로그인 실패 - {type(exc).__name__}: {exc}")
        return 20

    try:
        info = cl.account_info()
        acc = info.username if hasattr(info, "username") else ""
    except Exception:
        acc = ""
    if acc and username.lower() != acc.lower():
        print(f"경고: 로그인 계정({acc})이 IG_USERNAME({username})과 다릅니다.")

    if not os.path.exists(args.image):
        print(f"오류: 이미지 없음 - {args.image}")
        return 13

    try:
        if args.mode.lower() == "story":
            media = cl.photo_upload_to_story(args.image)
            print("업로드 성공(story): %s" % getattr(media, "pk", ""))
        else:
            media = cl.photo_upload(args.image, args.caption)
            print("업로드 성공(feed): %s" % getattr(media, "pk", ""))
    except Exception as exc:
        print(f"오류: 업로드 실패 - {type(exc).__name__}: {exc}")
        return 21

    return 0


if __name__ == "__main__":
    sys.exit(main())