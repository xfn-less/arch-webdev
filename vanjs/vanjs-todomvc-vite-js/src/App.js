import "todomvc-app-css/index.css";
import { v4 as randomUUID } from "uuid";
import van from "vanjs-core";
import { TodoItem } from "./components/TodoItem.js";

const { a, button, footer, h1, header, input, label, li, section, span, ul } =
  van.tags;

const loadTodos = () => {
  try {
    return JSON.parse(localStorage.getItem("todos") ?? "[]");
  } catch (error) {
    return [];
  }
};

const visibleTodos = (todos) => todos.filter((todo) => !todo.is_delete);

const filteredTodos = (todos, filter) =>
  visibleTodos(todos).filter(
    (todo) =>
      (filter === "active" && !todo.done) ||
      (filter === "completed" && todo.done) ||
      filter === "all",
  );

export const App = () => {
  const todos = van.state(loadTodos());
  const inputTodo = van.state("");
  const filter = van.state("all");

  const onToggleAll = (e) => {
    const checked = e.target.checked;
    todos.val = todos.val.map((todo) =>
      todo.is_delete ? todo : { ...todo, done: checked },
    );
  };

  const onClearCompleted = () => {
    todos.val = todos.val.map((todo) =>
      todo.done && !todo.is_delete ? { ...todo, is_delete: true } : todo,
    );
  };

  const addTodo = () => {
    const label = inputTodo.val.trim();
    if (!label) return;

    todos.val = [
      ...todos.val,
      {
        id: randomUUID(),
        label,
        done: false,
        is_delete: false,
      },
    ];
    inputTodo.val = "";
  };

  van.derive(() => {
    localStorage.setItem("todos", JSON.stringify(todos.val));
  });

  return section(
    { class: "todoapp" },
    header(
      { class: "header" },
      h1("todos app"),
      input({
        value: inputTodo,
        class: "new-todo",
        placeholder: "What needs to be done?",
        autofocus: "",
        oninput: (e) => {
          inputTodo.val = e.target.value;
        },
        onkeypress: (e) => {
          if (e.key === "Enter") addTodo();
        },
      }),
    ),

    section(
      { class: "main" },
      () =>
        input({
          id: "toggle-all",
          class: "toggle-all",
          type: "checkbox",
          onchange: onToggleAll,
          checked: visibleTodos(todos.val).every((todo) => todo.done),
        }),
      label({ for: "toggle-all" }, "Mark all as complete"),
      () =>
        ul(
          { class: "todo-list" },
          filteredTodos(todos.val, filter.val).map((todo) =>
            TodoItem({
              todo,
              onChange: (nextTodo) => {
                todos.val = todos.val.map((item) =>
                  item.id === nextTodo.id ? nextTodo : item,
                );
              },
            }),
          ),
        ),
      footer(
        { class: "footer" },
        span({ class: "todo-count" }, () => {
          const activeCount = visibleTodos(todos.val).filter(
            (todo) => !todo.done,
          ).length;
          return `${activeCount} item${activeCount === 1 ? "" : "s"} left`;
        }),
        () =>
          ul(
            { class: "filters" },
            li(
              a(
                {
                  href: "#/",
                  class: filter.val === "all" ? "selected" : "",
                  onclick: () => (filter.val = "all"),
                },
                "All",
              ),
            ),
            li(
              a(
                {
                  href: "#/active",
                  class: filter.val === "active" ? "selected" : "",
                  onclick: () => (filter.val = "active"),
                },
                "Active",
              ),
            ),
            li(
              a(
                {
                  href: "#/completed",
                  class: filter.val === "completed" ? "selected" : "",
                  onclick: () => (filter.val = "completed"),
                },
                "Completed",
              ),
            ),
          ),
        () =>
          visibleTodos(todos.val).some((todo) => todo.done)
            ? button(
                { class: "clear-completed", onclick: onClearCompleted },
                "Clear completed",
              )
            : "",
      ),
    ),
  );
};
