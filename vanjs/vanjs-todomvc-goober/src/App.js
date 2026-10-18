import { v4 as randomUUID } from "uuid"
import { css, glob } from "goober"
import van from "vanjs-core"
import { TodoItem } from "./components/TodoItem.js"

const { a, button, footer, h1, header, input, label, li, section, span, ul } = van.tags

glob`
  html,
  body {
    margin: 0;
    padding: 0;
  }

  button {
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    font-size: 100%;
    vertical-align: baseline;
    font-family: inherit;
    font-weight: inherit;
    color: inherit;
    -webkit-appearance: none;
    appearance: none;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  body {
    font: 14px "Helvetica Neue", Helvetica, Arial, sans-serif;
    line-height: 1.4em;
    background: #f5f5f5;
    color: #111111;
    min-width: 230px;
    max-width: 550px;
    margin: 0 auto;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    font-weight: 300;
  }

  :focus,
  .toggle:focus + label,
  .toggle-all:focus + label {
    box-shadow: 0 0 2px 2px #cf7d7d;
    outline: 0;
  }

  @media screen and (-webkit-min-device-pixel-ratio: 0) {
    .toggle-all,
    .toggle {
      background: none;
    }

    .toggle {
      height: 40px;
    }
  }
`

const todoapp = css`
  background: #fff;
  margin: 130px 0 40px 0;
  position: relative;
  box-shadow:
    0 2px 4px 0 rgba(0, 0, 0, 0.2),
    0 25px 50px 0 rgba(0, 0, 0, 0.1);

  input::-webkit-input-placeholder {
    font-style: italic;
    font-weight: 400;
    color: rgba(0, 0, 0, 0.4);
  }

  input::-moz-placeholder {
    font-style: italic;
    font-weight: 400;
    color: rgba(0, 0, 0, 0.4);
  }

  input::input-placeholder {
    font-style: italic;
    font-weight: 400;
    color: rgba(0, 0, 0, 0.4);
  }
`

const title = css`
  position: absolute;
  top: -140px;
  width: 100%;
  font-size: 80px;
  font-weight: 200;
  text-align: center;
  color: #b83f45;
  -webkit-text-rendering: optimizeLegibility;
  -moz-text-rendering: optimizeLegibility;
  text-rendering: optimizeLegibility;
`

const textInput = css`
  position: relative;
  margin: 0;
  width: 100%;
  font-size: 24px;
  font-family: inherit;
  font-weight: inherit;
  line-height: 1.4em;
  color: inherit;
  padding: 6px;
  border: 1px solid #999;
  box-shadow: inset 0 -1px 5px 0 rgba(0, 0, 0, 0.2);
  box-sizing: border-box;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
`

const newTodo = css`
  padding: 16px 16px 16px 60px;
  height: 65px;
  border: none;
  background: rgba(0, 0, 0, 0.003);
  box-shadow: inset 0 -2px 1px rgba(0, 0, 0, 0.03);
`

const main = css`
  position: relative;
  z-index: 2;
  border-top: 1px solid #e6e6e6;
`

const toggleAll = css`
  width: 1px;
  height: 1px;
  border: none;
  opacity: 0;
  position: absolute;
  right: 100%;
  bottom: 100%;

  &:checked + label:before {
    color: #484848;
  }
`

const toggleAllLabel = css`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 45px;
  height: 65px;
  font-size: 0;
  position: absolute;
  top: -65px;
  left: 0;

  &:before {
    content: "❯";
    display: inline-block;
    font-size: 22px;
    color: #949494;
    padding: 10px 27px 10px 27px;
    -webkit-transform: rotate(90deg);
    transform: rotate(90deg);
  }
`

const todoList = css`
  margin: 0;
  padding: 0;
  list-style: none;
`

const appFooter = css`
  padding: 10px 15px;
  height: 20px;
  text-align: center;
  font-size: 15px;
  border-top: 1px solid #e6e6e6;

  &:before {
    content: "";
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 50px;
    overflow: hidden;
    box-shadow:
      0 1px 1px rgba(0, 0, 0, 0.2),
      0 8px 0 -3px #f6f6f6,
      0 9px 1px -3px rgba(0, 0, 0, 0.2),
      0 16px 0 -6px #f6f6f6,
      0 17px 2px -6px rgba(0, 0, 0, 0.2);
  }

  @media (max-width: 430px) {
    height: 50px;
  }
`

const todoCount = css`
  float: left;
  text-align: left;

  strong {
    font-weight: 300;
  }
`

const filters = css`
  margin: 0;
  padding: 0;
  list-style: none;
  position: absolute;
  right: 0;
  left: 0;

  li {
    display: inline;
  }

  @media (max-width: 430px) {
    bottom: 10px;
  }
`

const filterLink = css`
  color: inherit;
  margin: 3px;
  padding: 3px 7px;
  text-decoration: none;
  border: 1px solid transparent;
  border-radius: 3px;

  &:hover {
    border-color: #db7676;
  }
`

const selectedFilter = css`
  border-color: #ce4646;
`

const clearCompleted = css`
  float: right;
  position: relative;
  line-height: 19px;
  text-decoration: none;
  cursor: pointer;

  &:active {
    float: right;
    position: relative;
    line-height: 19px;
    text-decoration: none;
    cursor: pointer;
  }

  &:hover {
    text-decoration: underline;
  }
`

const loadTodos = () => {
  try {
    return JSON.parse(localStorage.getItem("todos") ?? "[]")
  } catch (error) {
    return []
  }
}

const visibleTodos = todos =>
  todos.filter(todo => !todo.is_delete)

const filteredTodos = (todos, filter) =>
  visibleTodos(todos).filter(todo =>
    filter === "active" && !todo.done ||
    filter === "completed" && todo.done ||
    filter === "all"
  )

export const App = () => {
  const todos = van.state(loadTodos())
  const inputTodo = van.state("")
  const filter = van.state("all")

  const onToggleAll = e => {
    const checked = e.target.checked
    todos.val = todos.val.map(todo =>
      todo.is_delete ? todo : { ...todo, done: checked }
    )
  }

  const onClearCompleted = () => {
    todos.val = todos.val.map(todo =>
      todo.done && !todo.is_delete ? { ...todo, is_delete: true } : todo
    )
  }

  const addTodo = () => {
    const label = inputTodo.val.trim()
    if (!label) return

    todos.val = [
      ...todos.val,
      {
        id: randomUUID(),
        label,
        done: false,
        is_delete: false,
      },
    ]
    inputTodo.val = ""
  }

  van.derive(() => {
    localStorage.setItem("todos", JSON.stringify(todos.val))
  })

  return section({ class: todoapp },
    header(
      h1({ class: title }, "todos"),
      input({
        value: inputTodo,
        class: `${textInput} ${newTodo}`,
        placeholder: "What needs to be done?",
        autofocus: "",
        oninput: e => {
          inputTodo.val = e.target.value
        },
        onkeypress: e => {
          if (e.key === "Enter") addTodo()
        },
      }),
    ),

    section({ class: main },
      () => input({
        id: "toggle-all",
        class: `toggle-all ${toggleAll}`,
        type: "checkbox",
        onchange: onToggleAll,
        checked: visibleTodos(todos.val).every(todo => todo.done),
      }),
      label({ for: "toggle-all", class: toggleAllLabel }, "Mark all as complete"),
      () => ul(
        { class: todoList },
        filteredTodos(todos.val, filter.val).map(todo =>
          TodoItem({
            todo,
            textInputClass: textInput,
            onChange: nextTodo => {
              todos.val = todos.val.map(item =>
                item.id === nextTodo.id ? nextTodo : item
              )
            },
          })
        )
      ),
      footer({ class: appFooter },
        span({ class: todoCount },
          () => {
            const activeCount = visibleTodos(todos.val).filter(todo => !todo.done).length
            return `${activeCount} item${activeCount === 1 ? "" : "s"} left`
          }
        ),
        () => ul({ class: filters },
          li(
            a({
              href: "#/",
              class: `${filterLink} ${filter.val === "all" ? selectedFilter : ""}`,
              onclick: () => filter.val = "all",
            }, "All")
          ),
          li(
            a({
              href: "#/active",
              class: `${filterLink} ${filter.val === "active" ? selectedFilter : ""}`,
              onclick: () => filter.val = "active",
            }, "Active")
          ),
          li(
            a({
              href: "#/completed",
              class: `${filterLink} ${filter.val === "completed" ? selectedFilter : ""}`,
              onclick: () => filter.val = "completed",
            }, "Completed")
          ),
        ),
        () => visibleTodos(todos.val).some(todo => todo.done)
          ? button({ class: clearCompleted, onclick: onClearCompleted }, "Clear completed")
          : "",
      ),
    ),
  )
}
