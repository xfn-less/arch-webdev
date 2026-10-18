import van from "vanjs-core";
import { createMemoId, formatMemoTime } from "./memoId.js";

const { h1, p, main, section, article, textarea, button, div, time } = van.tags;

const MEMOS_STORAGE_KEY = "memos";

const loadMemos = () => {
  const value = localStorage.getItem(MEMOS_STORAGE_KEY);
  const memos = JSON.parse(value);
  return Array.isArray(memos) ? memos : [];
};

const saveMemos = (memos) => {
  localStorage.setItem(MEMOS_STORAGE_KEY, JSON.stringify(memos));
};

const App = () => {
  const draft = van.state("");
  const memos = van.state(loadMemos());

  const setMemos = (nextMemos) => {
    memos.val = nextMemos;
    saveMemos(nextMemos);
  };

  const addMemo = () => {
    if (draft.val.trim()) {
      const memo = { id: createMemoId(memos.val), content: draft.val };
      setMemos([...memos.val, memo]);
    }
    draft.val = "";
  };
  const delMemo = (id) => {
    setMemos(memos.val.filter((item) => id !== item.id));
  };

  return main(
    h1("Memos"),
    textarea({
      value: draft,
      placeholder: "写点什么...",
      oninput: (e) => (draft.val = e.target.value),
    }),
    p(() => `草稿: ${draft.val}`),
    button(
      {
        class: "addBtn",
        onclick: addMemo,
      },
      "保存",
    ),
    () =>
      section(
        memos.val.map((memo) =>
          article(
            p(memo.content),
            time(formatMemoTime(memo.id)),
            button(
              {
                class: "delBtn",
                onclick: () => delMemo(memo.id),
              },
              "删除",
            ),
          ),
        ),
      ),
  );
};

van.add(document.getElementById("app"), App());
