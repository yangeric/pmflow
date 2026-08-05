set -u
# CI 是直接對著剛啟動的 API 跑；本機要對容器裡的那一套跑時用
#   API=http://localhost:8481/api/v1 bash test/e2e.sh
API=${API:-http://127.0.0.1:8080/api/v1}
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

# 用「標題」而非編號取任務欄位。示範資料重編號時，測試不該跟著壞。
tid(){ echo "$TASKS" | python3 -c "
import sys,json
d=json.load(sys.stdin)['tasks']
m=[t for t in d if t['title']=='$1']
assert m, '找不到任務：$1'
print(m[0]['$2'])
"; }

echo "── 5. 任務清單 ──"
TASKS=$(curl -s -H "$AUTH" "$API/projects/$PID/tasks")
TN=$(echo "$TASKS" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["tasks"]))')
[ "$TN" -ge 8 ] && ok "MRG 任務數 $TN（>=8）" || no "任務數" "只有 $TN"
T_REQ=$(tid "需求確認與盤點" id)      # 有下游依賴
T_NET=$(tid "網路架構確認" id)        # 一回一逾期
T_BUY=$(tid "採購與到貨" id)          # 已回覆，且是轉單位回的
T_CON=$(tid "機櫃配置施工" id)        # 採購的下游
T_TEST=$(tid "系統遷移測試" id)       # 未到期
T_EPIC=$(tid "前置準備" id)           # 大項目，用來測父子關聯

echo "── 6. 發文追蹤：彙總狀態 ──"
chk "網路架構確認（一回一逾期）彙總為 OVERDUE" "$(tid "網路架構確認" inquiryState)" "OVERDUE"
chk "採購與到貨（已回覆）彙總為 REPLIED"     "$(tid "採購與到貨" inquiryState)" "REPLIED"
chk "系統遷移測試（未到期）彙總為 AWAITING"  "$(tid "系統遷移測試" inquiryState)" "AWAITING"

echo "── 7. 回覆單位 ≠ 提問單位 ──"
DET=$(curl -s -H "$AUTH" $API/tasks/$T_BUY)
ASKED=$(echo "$DET" | python3 -c 'import sys,json;print(json.load(sys.stdin)["inquiries"][0]["askedToUnit"])')
REPL=$(echo "$DET" | python3 -c 'import sys,json;print(json.load(sys.stdin)["inquiries"][0]["repliedByUnit"])')
chk "提問單位 = 資訊部" "$ASKED" "資訊部"
chk "回覆單位 = 宏碁資服（轉單位）" "$REPL" "宏碁資服"

echo "── 8. 逾期天數是算出來的 ──"
OVD=$(curl -s -H "$AUTH" $API/tasks/$T_NET | python3 -c '
import sys,json
for i in json.load(sys.stdin)["inquiries"]:
    if i["status"]=="OVERDUE": print(i["askedToUnit"], i["daysOverdue"])')
[ -n "$OVD" ] && ok "逾期詢問單：$OVD 天" || no "逾期計算" "沒有算出逾期"

echo "── 9. 新增詢問單 + 預設期望回覆日 ──"
NEWQ=$(curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $API/tasks/$T_REQ/inquiries \
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

echo "── 13. 不成環的排程依賴要建得起來 ──"
# 這一項是為了守住「只有真的成環才擋」。少了它，環偵測寫成永遠回報成環
# 也一樣看不出來 —— 下一項本來就預期 409，兩種錯法給的結果一模一樣。
NEWA=$(curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $API/projects/$PID/tasks \
  -d '{"title":"環偵測用－上游"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
NEWB=$(curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $API/projects/$PID/tasks \
  -d '{"title":"環偵測用－下游"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
C=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H 'content-type: application/json' \
  -X POST $API/tasks/$NEWA/links -d "{\"targetId\":\"$NEWB\",\"linkType\":\"FS\"}")
chk "兩張無關的任務建 FS → 201" "$C" "201"
C=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H 'content-type: application/json' \
  -X POST $API/tasks/$NEWB/links -d "{\"targetId\":\"$NEWA\",\"linkType\":\"FS\"}")
chk "反向再建一條 → 409（真的成環）" "$C" "409"

echo "── 14. 循環依賴要被擋下 ──"
R=$(curl -s -w '\n%{http_code}' -H "$AUTH" -H 'content-type: application/json' \
  -X POST $API/tasks/$T_BUY/links -d "{\"targetId\":\"$T_REQ\",\"linkType\":\"FS\"}")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | head -n -1)
chk "反向 FS 造成環 → 409" "$CODE" "409"
echo "$BODY" | grep -q "cycle" && ok "回傳環的路徑：$(echo "$BODY" | python3 -c 'import sys,json;print(" → ".join(json.load(sys.stdin)["cycle"]))')" || no "環路徑" "$BODY"

echo "── 15. 父子任務之間不能建排程依賴 ──"
C=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H 'content-type: application/json' \
  -X POST $API/tasks/$T_EPIC/links -d "{\"targetId\":\"$T_NET\",\"linkType\":\"FS\"}")
chk "父→子 建依賴被擋 (409，規格 §5.3)" "$C" "409"

echo "── 16. 看板拖曳：換欄 + 排序 ──"
MV=$(curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $API/tasks/$T_BUY/move \
  -d "{\"statusKey\":\"doing\",\"beforeId\":\"$T_REQ\"}")
NS=$(echo "$MV" | python3 -c 'import sys,json;print(json.load(sys.stdin)["statusKey"])')
chk "拖到「進行中」欄" "$NS" "doing"
NR=$(echo "$MV" | python3 -c 'import sys,json;print(json.load(sys.stdin)["rank"])')
ok "新 rank = $NR（fractional，只 UPDATE 一列）"

echo "── 17. 拖甘特長條，下游跟著動 ──"
TASKS=$(curl -s -H "$AUTH" "$API/projects/$PID/tasks"); BEFORE=$(tid "機櫃配置施工" startDate | cut -c1-10)
# 從採購與到貨目前的日期往後推 40 天，保證一定有變化，
# 這支腳本才能對同一個資料庫重複執行
CUR=$(tid "採購與到貨" startDate | cut -c1-10)
NS=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$CUR')+datetime.timedelta(days=40)).isoformat())")
NE=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$CUR')+datetime.timedelta(days=59)).isoformat())")
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $API/tasks/$T_BUY/reschedule \
  -d "{\"startDate\":\"$NS\",\"dueDate\":\"$NE\",\"cascade\":true}" >/dev/null
TASKS=$(curl -s -H "$AUTH" "$API/projects/$PID/tasks"); AFTER=$(tid "機櫃配置施工" startDate | cut -c1-10)
[ "$BEFORE" != "$AFTER" ] && ok "採購與到貨改期 → 下游機櫃配置施工 由 $BEFORE 推到 $AFTER" || no "連動" "沒有推動下游"

echo "── 18. 關聯網路圖資料 ──"
G=$(curl -s -H "$AUTH" $API/projects/$PID/graph)
GN=$(echo "$G" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d["nodes"]),len(d["edges"]))')
ok "關聯圖：$GN（節點 邊）"

echo "── 19. 發文追蹤看板（跨專案）──"
BD=$(curl -s -H "$AUTH" "$API/workspaces/$WSID/inquiry-board?state=AWAITING,OVERDUE")
BN=$(echo "$BD" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["inquiries"]))')
[ "$BN" -ge 1 ] && ok "追蹤看板列出 $BN 筆待回/逾期" || no "看板" "$BD"

echo "── 20. 單位統計 ──"
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

echo "── 21. 新使用者註冊 ──"
# 用隨機信箱，讓這支腳本可以對同一個資料庫重複執行
NEWMAIL="jack-$RANDOM$RANDOM@example.com"
REG=$(curl -s -w '\n%{http_code}' -X POST $API/auth/register -H 'content-type: application/json' \
  -d "{\"email\":\"$NEWMAIL\",\"password\":\"hunter2024\",\"displayName\":\"Jack\"}")
chk "註冊成功" "$(echo "$REG" | tail -1)" "201"
DUP=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/auth/register -H 'content-type: application/json' \
  -d "{\"email\":\"$NEWMAIL\",\"password\":\"hunter2024\",\"displayName\":\"Jack\"}")
chk "重複 email 被擋" "$DUP" "400"

echo "── 22. 越權存取要被擋（IDOR）──"
JT=$(curl -s -X POST $API/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"$NEWMAIL\",\"password\":\"hunter2024\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
C=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $JT" $API/tasks/$T_BUY)
chk "非專案成員讀別人的任務 → 403" "$C" "403"
C=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $JT" -H 'content-type: application/json' \
  -X POST $API/inquiries/$QID/mark-replied -d '{}')
chk "非成員改別人的詢問單 → 403" "$C" "403"

echo "── 23. 通知：四種事件都要送到對的人 ──"
# 沿用第 21 項註冊出來的 Jack（$JT），他跟 demo 是不同人，
# 才驗得出「自己做的事不通知自己」以外的那一半。
# 一律比「做了動作之後多了幾則」，不是比總數 ——
# 這支腳本要能對同一個資料庫重複執行，總數會一直累加。
UNREAD(){ curl -s -H "Authorization: Bearer $1" $API/notifications \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['unread'])"; }
KIND(){ curl -s -H "Authorization: Bearer $1" $API/notifications \
  | python3 -c "import sys,json;print(len([x for x in json.load(sys.stdin)['items'] if x['kind']=='$2' and x['readAt'] is None]))"; }

curl -s -o /dev/null -X POST -H "$AUTH" $API/notifications/read-all
curl -s -o /dev/null -X POST -H "Authorization: Bearer $JT" $API/notifications/read-all
chk "全部標為已讀之後未讀歸零" "$(UNREAD "$TOK")" "0"

# 這一輪要用到的兩張任務，現開現用，才不會被前幾項改過的狀態干擾
NT_A=$(curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $API/projects/$PID/tasks \
  -d '{"title":"通知測試－甲"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
NT_B=$(curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $API/projects/$PID/tasks \
  -d '{"title":"通知測試－乙"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# 申請加入 → 專案建立者收到
curl -s -o /dev/null -H "Authorization: Bearer $JT" -H 'content-type: application/json' \
  -X POST $API/projects/$PID/join-requests -d '{"message":"我想幫忙"}'
chk "有人申請加入 → 建立者收到 JOIN_REQUESTED" "$(KIND "$TOK" JOIN_REQUESTED)" "1"

# 核准 → 申請人收到
RID=$(curl -s -H "$AUTH" $API/projects/$PID/join-requests \
  | python3 -c 'import sys,json;r=json.load(sys.stdin)["requests"];print(r[0]["id"] if r else "")')
curl -s -o /dev/null -H "$AUTH" -H 'content-type: application/json' \
  -X POST $API/projects/$PID/join-requests/$RID/approve -d '{"role":"EDITOR"}'
chk "申請被核准 → 申請人收到 JOIN_APPROVED" "$(KIND "$JT" JOIN_APPROVED)" "1"

# 指派 → 被指派的人收到
JID=$(curl -s -H "Authorization: Bearer $JT" $API/auth/me | python3 -c 'import sys,json;print(json.load(sys.stdin)["user"]["id"])')
curl -s -o /dev/null -H "$AUTH" -H 'content-type: application/json' \
  -X PATCH $API/tasks/$NT_A -d "{\"assigneeId\":\"$JID\"}"
chk "任務被指派 → 收到 TASK_ASSIGNED" "$(KIND "$JT" TASK_ASSIGNED)" "1"

# 指派給自己不該有通知
DEMOID=$(curl -s -H "$AUTH" $API/auth/me | python3 -c 'import sys,json;print(json.load(sys.stdin)["user"]["id"])')
BEFORE_SELF=$(UNREAD "$TOK")
curl -s -o /dev/null -H "$AUTH" -H 'content-type: application/json' \
  -X PATCH $API/tasks/$NT_B -d "{\"assigneeId\":\"$DEMOID\"}"
chk "指派給自己不通知自己" "$(UNREAD "$TOK")" "$BEFORE_SELF"

# 被指向 → 該任務的負責人收到（Jack 把自己那張指向 demo 負責的那張）
curl -s -o /dev/null -H "Authorization: Bearer $JT" -H 'content-type: application/json' \
  -X POST $API/tasks/$NT_A/links -d "{\"targetId\":\"$NT_B\",\"linkType\":\"FS\"}"
chk "任務被指向 → 負責人收到 TASK_LINKED" "$(KIND "$TOK" TASK_LINKED)" "1"

# 別人的通知碰不得
NID=$(curl -s -H "Authorization: Bearer $JT" $API/notifications \
  | python3 -c 'import sys,json;d=json.load(sys.stdin)["items"];print(d[0]["id"] if d else "")')
C=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -X POST $API/notifications/$NID/read)
chk "標記別人的通知已讀 → 404" "$C" "404"

echo "── 24. 任務種類的上下關係 ──"
# 大項目只能在最上層或另一個大項目底下；問題的上層一定要是一張任務。
# 四個入口（建立、改任務、拖曳、改種類連帶影響子任務）共用 lib/hierarchy.ts。
CODE(){ curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H 'content-type: application/json' "$@"; }
H_TASK=$(curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $API/projects/$PID/tasks \
  -d '{"title":"種類規則－母任務","type":"TASK"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

chk "建立：大項目掛在任務底下 → 400" \
  "$(CODE -X POST $API/projects/$PID/tasks -d "{\"title\":\"種類規則－大項目\",\"type\":\"EPIC\",\"parentId\":\"$H_TASK\"}")" "400"
chk "建立：問題沒有上層 → 400" \
  "$(CODE -X POST $API/projects/$PID/tasks -d '{"title":"種類規則－孤兒問題","type":"BUG"}')" "400"
chk "建立：問題掛在任務底下 → 201" \
  "$(CODE -X POST $API/projects/$PID/tasks -d "{\"title\":\"種類規則－問題\",\"type\":\"BUG\",\"parentId\":\"$H_TASK\"}")" "201"

TASKS=$(curl -s -H "$AUTH" "$API/projects/$PID/tasks")
H_BUG=$(tid "種類規則－問題" id)

# 底下掛著問題的任務改成大項目 → 那些問題就變成掛在大項目底下，要擋
chk "改種類：底下有問題的任務改成大項目 → 400" \
  "$(CODE -X PATCH $API/tasks/$H_TASK -d '{"type":"EPIC"}')" "400"
# 不動種類、不動上層的異動一律放行（既有資料可能本來就不合規）
chk "只改標題不受影響 → 200" \
  "$(CODE -X PATCH $API/tasks/$H_TASK -d '{"title":"種類規則－母任務"}')" "200"
# 拖曳只改上層也要擋
chk "拖曳：把問題拖到大項目底下 → 400" \
  "$(CODE -X POST $API/tasks/$H_BUG/move -d "{\"parentId\":\"$T_EPIC\"}")" "400"
# 里程碑不受限制
chk "建立：里程碑掛在任務底下 → 201" \
  "$(CODE -X POST $API/projects/$PID/tasks -d "{\"title\":\"種類規則－里程碑\",\"type\":\"MILESTONE\",\"parentId\":\"$H_TASK\"}")" "201"

# 收乾淨，不要在示範資料庫裡留下測試用的任務
TASKS=$(curl -s -H "$AUTH" "$API/projects/$PID/tasks")
for t in "種類規則－里程碑" "種類規則－問題" "種類規則－母任務"; do
  curl -s -o /dev/null -X DELETE -H "$AUTH" $API/tasks/$(tid "$t" id)
done

echo
echo "════════ 通過 $pass 項，失敗 $fail 項 ════════"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
