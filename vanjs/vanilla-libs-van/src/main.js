import { css, glob } from "goober";
import van from "vanjs-core";
import { SortableDemo } from "./SortableDemo.js";
import { TooltipDemo } from "./TooltipDemo.js";

const { main } = van.tags;

glob`
  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    background: #f7f7f4;
    color: #202124;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
      sans-serif;
  }

  button {
    font: inherit;
  }

  h1,
  h2,
  p {
    margin-top: 0;
  }

  h1 {
    margin-bottom: 8px;
    font-size: 32px;
  }

  h2 {
    margin-bottom: 8px;
    font-size: 18px;
  }

  p {
    color: #5f6368;
    line-height: 1.5;
  }
`;

const appClass = css`
  width: min(100% - 32px, 720px);
  margin: 36px auto;
`;

const App = () => {
  return main({ class: appClass }, TooltipDemo(), SortableDemo());
};

van.add(document.getElementById("app"), App());
