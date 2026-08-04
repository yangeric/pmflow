/** 關聯圖、日曆、甘特 用到的文字。寫法見 strings/index.ts */
export const chart = {
  /** 關聯網路圖（React Flow） */
  graph: {
    loading: '載入關聯圖…',
    empty: '這裡還沒有任務。到清單或看板新增之後，關聯圖就會把它們畫出來。',

    /**
     * 關聯類型的說法，一律不出現 FS／SS／FF／SF ——
     * 資料庫存的是縮寫，畫面上永遠講完整句型。
     *
     * chip 是掛在線上的短句（線很擠，只放得下四個字），
     * label 是下拉選單與清單用的完整句型。兩者指的是同一件事，改要一起改。
     */
    linkChip: {
      FS: '完成後開始', SS: '同時開始', FF: '同時完成', SF: '開始後完成',
      RELATES: '相關', BLOCKS: '阻擋', DUPLICATES: '重複於', REQUIRES: '需要',
    },
    linkLabel: {
      FS: '等待任務完成，才能開始',
      SS: '等待任務開始，才能開始',
      FF: '等待任務完成，才能完成',
      SF: '等待任務開始，才能完成',
      RELATES: '相關', BLOCKS: '阻擋', DUPLICATES: '重複於', REQUIRES: '需要',
    },
    /** 線上的短句後面接的間隔天數 */
    lag: (days: number) => `．間隔 ${days > 0 ? '+' : ''}${days} 天`,

    /**
     * 把一條關聯講成一句完整的話，而且分方向講。
     * 同一條「完成後開始」站在上游和下游看到的意思相反 —— 這是最容易看錯的地方。
     * 與任務詳情頁的說法保持一致。
     */
    sentence: {
      FS: {
        outgoing: (ref: string) => `${ref} 要等我完成，才能開始`,
        incoming: (ref: string) => `要等 ${ref} 完成，我才能開始`,
      },
      SS: {
        outgoing: (ref: string) => `${ref} 要等我開始，才能開始`,
        incoming: (ref: string) => `要等 ${ref} 開始，我才能開始`,
      },
      FF: {
        outgoing: (ref: string) => `${ref} 要等我完成，才能完成`,
        incoming: (ref: string) => `要等 ${ref} 完成，我才能完成`,
      },
      SF: {
        outgoing: (ref: string) => `${ref} 要等我開始，才能完成`,
        incoming: (ref: string) => `要等 ${ref} 開始，我才能完成`,
      },
      RELATES: {
        outgoing: (ref: string) => `與 ${ref} 相關`,
        incoming: (ref: string) => `與 ${ref} 相關`,
      },
      BLOCKS: {
        outgoing: (ref: string) => `阻擋 ${ref}`,
        incoming: (ref: string) => `被 ${ref} 阻擋`,
      },
      DUPLICATES: {
        outgoing: (ref: string) => `重複於 ${ref}`,
        incoming: (ref: string) => `被 ${ref} 重複`,
      },
      REQUIRES: {
        outgoing: (ref: string) => `需要 ${ref}`,
        incoming: (ref: string) => `被 ${ref} 需要`,
      },
    },

    /** 工具列 */
    toolbar: {
      zoomIn: '放大',
      zoomOut: '縮小',
      fitAll: '全部顯示',
      relayout: '重新排列',
      relayoutTip: '把拖亂的節點放回自動佈局的位置',
      boxSelect: '框選',
      boxSelectOn: '✓ 框選',
      boxSelectTipOn:
        '框選中：左鍵拉出範圍選取多張任務，選好之後拖曳就會一起移動。用右鍵或滾輪平移畫面',
      boxSelectTipOff:
        '框選：左鍵拉出範圍選取多張任務，一起拖曳。（也可以隨時按住 Shift 拉框）',
      showSemantic: '語意關聯（旁邊）',
      showBlocked: '🚧 卡住',
      showParallel: '⇉ 並行',
      newLink: '拉線建立',
      groupScheduling: '排程（會推動日期）',
      groupSemantic: '語意（不影響排程）',
    },

    /** 節點上那排小徽章。徽章本身只留兩三個字，完整說法在 tip 上 */
    badge: {
      entry: '起點',
      /** 框自己的標題列上講的，看的是「外層框裡」的先後 */
      entryBoxTip: '這一包的起點：外層框裡沒有任何任務排在它前面',
      entryTaskTip: '這一包的起點：框裡沒有任何任務排在它前面。指進框的依賴擋住的就是這幾張',
      childCount: (count: number) => `內含 ${count} 張`,
      childCountTip: '這個框裡直接放著幾張任務。框的日期與進度由裡面那些任務彙總出來',
      epic: '大項目',
      epicTip: '這張任務底下還可以掛別的任務',
      milestone: '里程碑',
      kinParent: '這張的上層',
      kinChild: '這張的下層',
      kinParentBoxTip: '這是選中任務的上層，兩者之間沒有依賴關係',
      kinParentTaskTip: '這是選中任務的上層大項目，兩者之間沒有依賴關係',
      kinChildTip: '這是選中任務底下的任務，兩者之間沒有依賴關係',
      blocked: '卡住',
      blockedTip: (refs: string) => `卡住：要等 ${refs}`,
      problem: '⚑ 有問題',
      problemTip: (text: string) => `目前遇到的問題：${text}`,
      sameStart: (count: number) => `同時開始 ${count}`,
      sameStartTip: (refs: string) => `跟 ${refs} 同一天開始`,
      sameFinish: (count: number) => `同時完成 ${count}`,
      sameFinishTip: (refs: string) => `跟 ${refs} 同一天完成`,
      overlap: (count: number) => `並行 ${count}`,
      overlapTip: (refs: string) => `可以跟 ${refs} 同時做`,
    },

    /** 匯合點：同時開始／同時完成畫成一個時間點，不是兩張任務之間的箭頭 */
    junction: {
      fork: '同時開始',
      join: '同時完成',
      forkTip: '同時開始：從這個時間點分出去',
      joinTip: '同時完成：在這個時間點收在一起',
    },

    /** 點一張任務之後，右上角那塊面板 */
    focus: {
      close: '取消聚焦',
      blocked: (refs: string) => `🚧 現在動不了：要等 ${refs}`,
      problem: (text: string) => `⚑ 目前遇到的問題：${text}`,
      sameStart: (refs: string) => `⇉ 同一天開始：${refs}`,
      sameFinish: (refs: string) => `⇥ 同一天完成：${refs}`,
      overlap: (refs: string) => `⇉ 可以同時做：${refs}`,
      noLinks: '這張任務還沒有左右關聯。',
      /** 關聯的另一端不在目前看得到的範圍裡 */
      otherProject: '（其他專案的任務）',
      open: '開啟任務',
    },

    /** 建立／刪除關聯 */
    link: {
      deleteConfirm: (label: string) => `要刪除這條關聯嗎？（${label}）`,
      /** 後端沒給理由時才用這句，有理由一律照後端的 */
      addFailed: '建立關聯失敗',
    },

    /** 最下面那條說明列 */
    legend: {
      rowLine: '線',
      rowIcon: '圖示',
      operation: '操作說明',
      operationTitle: '怎麼操作',
      semantic: '語意關聯',
      box: '大項目的框',
      junction: '匯合點',
    },

    /**
     * 說明列上滑過去才出現的完整說明。
     * 這裡是唯一講清楚「這個記號到底是什麼意思」的地方，不要為了短而砍句子。
     */
    help: {
      operation:
        '・點節點：只留亮它的鄰居，其餘淡出。再點一次取消\n' +
        '・雙擊節點：開啟那張任務\n' +
        '・從節點右側的圓點拉到另一張任務：建立關聯（種類用上面的「拉線建立」選）\n' +
        '・點線：刪除那條關聯\n' +
        '・拖節點可以自己排版，按「重新排列」放回自動位置\n' +
        '・「框選」開著時左鍵拉出範圍選多張，一起拖曳；右鍵平移畫面\n' +
        '・滾輪縮放，或用左上角的＋／－',

      scheduling: {
        FS: '等待任務完成，才能開始。上游做完的隔天下游才動得了 —— 最常見的一種',
        SS: '等待任務開始，才能開始。兩張要在同一天起跑，人力得同時到位',
        FF: '等待任務完成，才能完成。兩張要在同一天收尾，驗收會撞在一起',
        SF: '等待任務開始，才能完成。少見，通常用在交接：新的開始了，舊的才能結束',
      },

      semantic:
        '相關／阻擋／重複於／需要。\n' +
        '虛線＝只是註記兩張任務的關係，改其中一張的日期不會推動另一張。',

      box:
        '大項目畫成一個框，底下的任務就排在框裡面。\n' +
        '框裡面是「這一包」的內容，不是先後關係 ——\n' +
        '大項目的日期與進度由裡面那些任務彙總出來。\n' +
        '框本身也是一張任務，可以指向後續任務：\n' +
        '一支從框拉出去的箭頭＝「這一整包做完，才能接下去」。',

      junction:
        '「同時開始」與「同時完成」不是兩張任務之間的一支箭頭，而是一個時間點。\n' +
        '橘＝同時開始（一支箭頭進、多支出）\n' +
        '紫＝同時完成（多支進、一支出）',

      /** 節點上的圖示。label 也是說明列上顯示的那幾個字 */
      icon: {
        blocked: {
          label: '🚧 卡住',
          text: '這張任務現在動不了：上游還沒完成，或同時開始的那一張還沒開始。\n' +
                '滑到節點上的紅色徽章可以看它在等誰 —— 會直接指到真正的源頭，\n' +
                '不是中間那一張。',
        },
        problem: {
          label: '⚑ 有問題',
          text: '有人在這張任務上寫下了「目前遇到的問題」。\n' +
                '跟紅色的「卡住」是兩回事：卡住是系統看任務關聯算出來的，\n' +
                '上游一完成就自己不見；問題是人自己打字寫的，要有人去解決、\n' +
                '在任務裡把它清掉才會消失。滑到節點上的旗子可以看寫了什麼。',
        },
        sameStart: {
          label: '⇉ 同時開始',
          text: '跟別的任務同一天開始。排人力時這幾張要一起看，同一天都得到位。',
        },
        sameFinish: {
          label: '⇥ 同時完成',
          text: '跟別的任務同一天完成。驗收、結案會撞在同一天。',
        },
        overlap: {
          label: '⇉ 並行',
          text: '期間重疊、彼此沒有先後，可以同時派不同的人做。\n' +
                '預設不顯示，要在上面的「並行」打勾。',
        },
        entry: {
          label: '起點',
          text: '這一包從這幾張開始 —— 框裡沒有任何任務排在它前面。\n' +
                '一包可以有好幾個起點，它們是同時可以動手的。\n' +
                '要讓整包等別的任務，把線拉到「框」上就好，\n' +
                '不必一張一張連 —— 擋住框就等於擋住裡面所有起點。',
        },
        childCount: {
          label: '內含 N 張',
          text: '框的標題列上寫的數字＝這個框裡直接放著幾張任務。\n' +
                '框的日期與進度由裡面那些任務彙總出來。',
        },
        milestone: {
          label: '里程碑',
          text: '只有一個時間點的任務，用來標「這天要交出什麼」。',
        },
      },

      inquiry: {
        AWAITING: '發文追蹤：發出去了，還在等對方回覆，也還沒到期望回覆日。',
        OVERDUE:  '發文追蹤：過了期望回覆日還沒回。逾期是查詢時算出來的，不是存下來的狀態。',
        PARTIAL:  '發文追蹤：問了好幾個單位，有的回了、有的還沒。',
        REPLIED:  '發文追蹤：都回覆了。回覆的單位可能跟提問的單位不同（轉單位）。',
      },
    },
  },

  /** 甘特圖（dhtmlx-gantt） */
  gantt: {
    col: {
      task: '任務',
      start: '開始',
      duration: '天',
      inquiry: '發文',
    },

    /**
     * dhtmlx 內建的 locale。月份與星期是畫面上讀得到的字，所以一併集中在這裡；
     * 少了任何一個鍵 dhtmlx 會噴 "Invalid day index"，不要只補一半。
     */
    locale: {
      monthFull: ['一月', '二月', '三月', '四月', '五月', '六月',
                  '七月', '八月', '九月', '十月', '十一月', '十二月'],
      monthShort: ['1月', '2月', '3月', '4月', '5月', '6月',
                   '7月', '8月', '9月', '10月', '11月', '12月'],
      dayFull: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
      dayShort: ['日', '一', '二', '三', '四', '五', '六'],
      newTask: '新任務',
      sectionDescription: '說明',
      sectionTime: '時間區間',
      confirmLinkDeleting: '要刪除這條關聯嗎？',
    },

    /** 時間軸刻度。%Y／%n／%j 是 dhtmlx 的日期格式符號，不要翻譯 */
    scale: {
      month: '%Y 年 %n 月',
      day: '%j',
    },

    /** 發文欄的小圖示，游標停著看是什麼狀態 */
    inquiryCell: {
      AWAITING: '待回覆',
      OVERDUE: '逾期未回',
      PARTIAL: '部分已回',
      REPLIED: '已回覆',
    },

    cyclic: '⚠️ 偵測到循環依賴，排程無法推算。請先移除造成環的關聯。',
    conflicts: (count: number) => `⚠️ ${count} 個排程衝突：`,
    conflictItem: (label: string, reason: string) => `${label}（${reason}）`,
    criticalPath: (count: number) =>
      `關鍵路徑 ${count} 個節點（後端以前向／後向遍歷求 total float = 0）`,
    dragHint: '拖曳長條可改期並連動下游，從長條端點拉線可建立依賴',
    addLinkFailed: '建立關聯失敗',
  },
} as const
