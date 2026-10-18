import { css } from "goober";
import tippy from "tippy.js";
import "tippy.js/dist/tippy.css";
import van from "vanjs-core";

const { button, h2, p, section } = van.tags;

const panelClass = css`
  margin-top: 18px;
  padding: 18px;
  border: 1px solid #ddded8;
  background: #fff;
`;

const primaryButtonClass = css`
  min-height: 40px;
  padding: 0 16px;
  border: 1px solid #1f6f5b;
  background: #1f6f5b;
  color: #fff;
  cursor: pointer;
`;

export const TooltipDemo = () => {
  const count = van.state(0);
  let tip;

  const el = button(
    {
      class: primaryButtonClass,
      onclick: () => {
        count.val += 1;
        tip?.setContent(`${count.val} 次`);
      },
    },
    () => `保存 ${count.val}`,
  );

  queueMicrotask(() => {
    tip = tippy(el, {
      content: `${count.val} 次`,
      placement: "bottom",
    });
  });

  return section(
    { class: panelClass },
    el,
  );
};
