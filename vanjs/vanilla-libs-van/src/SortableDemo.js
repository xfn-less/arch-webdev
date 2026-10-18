import { css } from "goober";
import Sortable from "sortablejs";
import van from "vanjs-core";

const { code, div, h2, li, p, section, span, ul } = van.tags;

const panelClass = css`
  margin-top: 18px;
  padding: 18px;
  border: 1px solid #ddded8;
  background: #fff;
`;

const sortableListClass = css`
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
`;

const sortableItemClass = css`
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 10px 12px;
  border: 1px solid #dadce0;
  background: #fafafa;
`;

const dragHandleClass = css`
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  border: 1px solid #d2d5d9;
  background: #fff;
  color: #5f6368;
  cursor: grab;
  user-select: none;

  &:active {
    cursor: grabbing;
  }
`;

const sortableGhostClass = css`
  opacity: 0.35;
  background: #dceee8;
`;

const stateViewClass = css`
  margin-top: 14px;
  padding: 10px 12px;
  background: #f1f3f4;
  color: #3c4043;
`;

const initialItems = [
  { id: "1", text: "1. VanJS 创建真实 DOM" },
  { id: "2", text: "2. Tippy 接管 tooltip 行为" },
  { id: "3", text: "3. Sortable 接管拖拽排序" },
  { id: "4", text: "4. 拖完后回写 VanJS state" },
];

export const SortableDemo = () => {
  const items = van.state(initialItems);

  const list = ul(
    { class: sortableListClass },
    items.val.map((item) =>
      li(
        {
          class: sortableItemClass,
          "data-id": item.id,
        },
        span({ class: dragHandleClass }, "☰"),
        span(item.text),
      ),
    ),
  );

  queueMicrotask(() => {
    Sortable.create(list, {
      animation: 150,
      handle: `.${dragHandleClass}`,
      ghostClass: sortableGhostClass,
      onEnd: () => {
        const orderedIds = Array.from(list.children).map((child) => child.dataset.id);
        items.val = orderedIds
          .map((id) => items.val.find((item) => item.id === id))
          .filter(Boolean);
      },
    });
  });

  return section(
    { class: panelClass },
    list,
    div(
      { class: stateViewClass },
      code(() => items.val.map((item) => item.id).join(" -> ")),
    ),
  );
};
