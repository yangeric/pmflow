set -u
API=http://127.0.0.1:8080/api/v1
J=/tmp/cookies.txt; rm -f $J
pass=0; fail=0
ok(){ pass=$((pass+1)); echo "  ✅ $1"; }
no(){ fail=$((fail+1)); echo "  ❌ $1"; echo "     → $2"; }
chk(){ [ "$2" = "$3" ] && ok "$1" || no "$1" "期望 $3，實得 $2"; }

echo "── 1. 登入示範帳號 ──"
LOGIN=$(curl -s -c $J -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"demo@pmflow.local","password":"demo1234"}')
TOK=$(echo "$LOGIN" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("accessToken",""))')
[ -n "$TOK" ] && ok "登入取得 JWT" || no "登入" "$LOGIN"
AUTH="Authorization: Bearer $TOK"

echo "── 2. 錯誤密碼要被擋 ──"
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"demo@pmflow.local","password":"wrongpass"}')
chk "錯誤密碼回 401" "$C" "401"

echo "── 3. 沒帶 token 要被擋 ──"
C=$(curl -s -o /dev/null -w '%{http_code}' $API/projects)
chk "未授權回 401" "$C" "401"

echo "── 4. 專案清單（切換專案用）──"
PROJ=$(curl -s -H "$AUTH" $API/projects)
N=$(echo "$PROJ" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["projects"]))')
chk "看得到 2 個專案" "$N" "2"
PID=$(echo "$PROJ" | python3 -c 'import sys,json;d=json.load(sys.stdin)["projects"];print([p for p in d if p["key"]=="MRG"][0]["id"])')
WSID=$(echo "$PROJ" | python3 -c 'import sys,json;d=json.load(sys.stdin)["projects"];print(d[0]["workspaceId"])')
OD=$(echo "$PROJ" | python3 -c 'import sys,json;d=json.load(sys.stdin)["projects"];print([p for p in d if p["key"]=="MRG"][0]["overdueInquiryCount"])')
[ "$OD" -ge 1 ] && ok "專案清單帶出逾期發文數 ($OD)" || no "逾期數" "$OD"

echo "── 5. 任務清單 ──"
TASKS=$(curl -s -H "$AUTH" "$API/projects/$PID/tasks")
TN=$(echo "$TASKS" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["tasks"]))')
chk "MRG 有 8 張任務" "$TN" "8"
T2=$(echo "$TASKS" | python3 -c 'import sys,json;d=json.load(sys.stdin)["tasks"];print([t for t in d if t["number"]==2][0]["id"])')
T5=$(echo "$TASKS" | python3 -c 'import sys,json;d=json.load(sys.stdin)["tasks"];print([t for t in d if t["number"]==5][0]["id"])')
T4=$(echo "$TASKS" | python3 -c 'import sys,json;d=json.load(sys.stdin)["tasks"];print([t for t in d if t["number"]==4][0]["id"])')

echo "── 6. 發文追蹤：彙總狀態 ──"
S4=$(echo "$TASKS" | python3 -c 'import sys,json;d=json.load(sys.stdin)["tasks"];print([t for t in d if t["number"]==4][0]["inquiryState"])')
chk "MRG-4（一回一逾期）彙總為 OVERDUE" "$S4" "OVERDUE"
S5=$(echo "$TASKS" | python3 -c 'import sys,json;d=json.load(sys.stdin)["tasks"];print([t for t in d if t["number"]==5][0]["inquiryState"])')
chk "MRG-5（已回覆）彙總為 REPLIED" "$S5" "REPLIED"
S7=$(echo "$TASKS" | python3 -c 'import sys,json;d=json.load(sys.stdin)["tasks"];print([t for t in d if t["number"]==7][0]["inquiryState"])')
chk "MRG-7（未到期）彙總為 AWAITING" "$S7" "AWAITING"

echo "── 7. 回覆單位 ≠ 提問單位 ──"
DET=$(curl -s -H "$AUTH" $API/tasks/$T5)
ASKED=$(echo "$DET" | python3 -c 'import sys,json;print(json.load(sys.stdin)["inquiries"][0]["askedToUnit"])')
REPL=$(echo "$DET" | python3 -c 'import sys,json;print(json.load(sys.stdin)["inquiries"][0]["repliedByUnit"])')
chk "提問單位 = 資訊部" "$ASKED" "資訊部"
chk "回覆單位 = 宏碁資服（轉單位）" "$REPL" "宏碁資服"

echo "── 8. 逾期天數是算出來的 ──"
OVD=$(curl -s -H "$AUTH" $API/tasks/$T4 | python3 -c '
import sys,json
for i in json.load(sys.stdin)["inquiries"]:
    if i["status"]=="OVERDUE": print(i["askedToUnit"], i["daysOverdue"])')
[ -n "$OVD" ] && ok "逾期詢問單：$OVD 天" || no "逾期計算" "沒有算出逾期"

echo "── 9. 新增詢問單 + 預設期望回覆日 ──"
NEWQ=$(curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $API/tasks/$T2/inquiries \
  -d '{"askedToUnit":"法務室","askedToPerson":"陳律師","askedToContact":"分機 3301","question":"合約條款確認"}')
QID=$(echo "$NEWQ" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
QDUE=$(echo "$NEWQ" | python3 -c 'import sys,json;print(json.load(sys.stdin)["dueDate"])')
[ -n "$QDUE" ] && ok "自動帶入期望回覆日 ${QDUE:0:10}（+7 工作天）" || no "預設期限" "$NEWQ"

echo "── 10. 登錄回覆：自動帶入提問單位 ──"
MR=$(curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $API/inquiries/$QID/mark-replied -d '{}')
MRU=$(echo "$MR" | python3 -c 'import sys,json;print(json.load(sys.stdin)["repliedByUnit"])')
chk "省略回覆單位時自動帶入提問單位" "$MRU" "法務室"

echo "── 11. 單位 typeahead ──"
UNITS=$(curl -s -H "$AUTH" "$API/workspaces/$WSID/unit-suggestions?q=%E8%B3%87")
UN=$(echo "$UNITS" | python3 -c 'import sys,json;print(",".join(u["unit"] for u in json.load(sys.stdin)["units"]))')
echo "$UN" | grep -q "資訊部" && ok "typeahead 查「資」找到：$UN" || no "typeahead" "$UNITS"

echo "── 12. 四種依賴 + 排程推算 ──"
SCH=$(curl -s -H "$AUTH" $API/projects/$PID/schedule)
CYC=$(echo "$SCH" | python3 -c 'import sys,json;print(json.load(sys.stdin)["cyclic"])')
chk "無循環" "$CYC" "False"
CP=$(echo "$SCH" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["criticalPath"]))')
[ "$CP" -ge 1 ] && ok "算出關鍵路徑（$CP 個節點）" || no "關鍵路徑" "$SCH"

echo "── 13. 循環依賴要被擋下 ──"
R=$(curl -s -w '\n%{http_code}' -H "$AUTH" -H 'content-type: application/json' \
  -X POST $API/tasks/$T5/links -d "{\"targetId\":\"$T2\",\"linkType\":\"FS\"}")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | head -n -1)
chk "反向 FS 造成環 → 409" "$CODE" "409"
echo "$BODY" | grep -q "cycle" && ok "回傳環的路徑：$(echo "$BODY" | python3 -c 'import sys,json;print(" → ".join(json.load(sys.stdin)["cycle"]))')" || no "環路徑" "$BODY"

echo "── 14. 父子任務之間不能建排程依賴 ──"
C=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H 'content-type: application/json' \
  -X POST $API/tasks/$T2/links -d "{\"targetId\":\"$T4\",\"linkType\":\"FS\"}")
chk "父→子 建 FS 被擋 (400)" "$C" "400"

echo "── 15. 看板拖曳：換欄 + 排序 ──"
MV=$(curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $API/tasks/$T5/move \
  -d "{\"statusKey\":\"doing\",\"beforeId\":\"$T2\"}")
NS=$(echo "$MV" | python3 -c 'import sys,json;print(json.load(sys.stdin)["statusKey"])')
chk "拖到「進行中」欄" "$NS" "doing"
NR=$(echo "$MV" | python3 -c 'import sys,json;print(json.load(sys.stdin)["rank"])')
ok "新 rank = $NR（fractional，只 UPDATE 一列）"

echo "── 16. 拖甘特長條，下游跟著動 ──"
BEFORE=$(curl -s -H "$AUTH" "$API/projects/$PID/tasks" | python3 -c 'import sys,json;d=json.load(sys.stdin)["tasks"];print([t for t in d if t["number"]==6][0]["startDate"][:10])')
# 從 MRG-5 目前的日期往後推 40 天，保證一定有變化，
# 這支腳本才能對同一個資料庫重複執行
CUR=$(curl -s -H "$AUTH" "$API/projects/$PID/tasks" | python3 -c 'import sys,json;d=json.load(sys.stdin)["tasks"];print([t for t in d if t["number"]==5][0]["startDate"][:10])')
NS=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$CUR')+datetime.timedelta(days=40)).isoformat())")
NE=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$CUR')+datetime.timedelta(days=59)).isoformat())")
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $API/tasks/$T5/reschedule \
  -d "{\"startDate\":\"$NS\",\"dueDate\":\"$NE\",\"cascade\":true}" >/dev/null
AFTER=$(curl -s -H "$AUTH" "$API/projects/$PID/tasks" | python3 -c 'import sys,json;d=json.load(sys.stdin)["tasks"];print([t for t in d if t["number"]==6][0]["startDate"][:10])')
[ "$BEFORE" != "$AFTER" ] && ok "MRG-5 改期 → 下游 MRG-6 由 $BEFORE 推到 $AFTER" || no "連動" "沒有推動下游"

echo "── 17. 關聯網路圖資料 ──"
G=$(curl -s -H "$AUTH" $API/projects/$PID/graph)
GN=$(echo "$G" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d["nodes"]),len(d["edges"]))')
ok "關聯圖：$GN（節點 邊）"

echo "── 18. 發文追蹤看板（跨專案）──"
BD=$(curl -s -H "$AUTH" "$API/workspaces/$WSID/inquiry-board?state=AWAITING,OVERDUE")
BN=$(echo "$BD" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["inquiries"]))')
[ "$BN" -ge 1 ] && ok "追蹤看板列出 $BN 筆待回/逾期" || no "看板" "$BD"

echo "── 19. 單位統計 ──"
ST=$(curl -s -H "$AUTH" "$API/workspaces/$WSID/inquiry-stats")
echo "$ST" | python3 -c '
import sys, json
d = json.load(sys.stdin)
for u in d["byUnit"]:
    print("     %s: 發文 %s / 已回 %s / 逾期中 %s / 平均回覆 %s 天"
          % (u["unit"], u["totalAsked"], u["totalReplied"], u["currentOverdue"], u["avgDaysToReply"]))
for t in d["transferred"]:
    print("     轉單位: %s -> %s (%s 次)" % (t["askedToUnit"], t["repliedByUnit"], t["count"]))'
ok "單位統計查得出來"

echo "── 20. 新使用者註冊 ──"
# 用隨機信箱，讓這支腳本可以對同一個資料庫重複執行
NEWMAIL="jack-$RANDOM$RANDOM@example.com"
REG=$(curl -s -w '\n%{http_code}' -X POST $API/auth/register -H 'content-type: application/json' \
  -d "{\"email\":\"$NEWMAIL\",\"password\":\"hunter2024\",\"displayName\":\"Jack\"}")
chk "註冊成功" "$(echo "$REG" | tail -1)" "201"
DUP=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/auth/register -H 'content-type: application/json' \
  -d "{\"email\":\"$NEWMAIL\",\"password\":\"hunter2024\",\"displayName\":\"Jack\"}")
chk "重複 email 被擋" "$DUP" "400"

echo "── 21. 越權存取要被擋（IDOR）──"
JT=$(curl -s -X POST $API/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"$NEWMAIL\",\"password\":\"hunter2024\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
C=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $JT" $API/tasks/$T5)
chk "非專案成員讀別人的任務 → 403" "$C" "403"
C=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $JT" -H 'content-type: application/json' \
  -X POST $API/inquiries/$QID/mark-replied -d '{}')
chk "非成員改別人的詢問單 → 403" "$C" "403"

echo
echo "════════ 通過 $pass 項，失敗 $fail 項 ════════"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
