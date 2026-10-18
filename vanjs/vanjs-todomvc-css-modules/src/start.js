import van from "vanjs-core";

const { div, p, input, span } = van.tags;

const name = van.state("world");

export const App = () => {
  van.add(
    document.body,
    input({
      value: name,
      oninput: (e) => (name.val = e.target.value),
    }),
    span(" Hello ", name),
  );
};
