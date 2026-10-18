import { v4 as randomUUID } from "uuid"
import van from "vanjs-core"
import { TodoItem } from "./components/TodoItem.js"
import styles from "./App.module.css"

const { a, button, footer, h1, header, input, label, li, section, span, ul } = van.tags

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

  return section({ class: styles.todoapp },
    header(
      h1({ class: styles.title }, "todos"),
      input({
        value: inputTodo,
        class: `${styles.textInput} ${styles.newTodo}`,
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

    section({ class: styles.main },
      () => input({
        id: "toggle-all",
        class: styles.toggleAll,
        type: "checkbox",
        onchange: onToggleAll,
        checked: visibleTodos(todos.val).every(todo => todo.done),
      }),
      label({ for: "toggle-all", class: styles.toggleAllLabel }, "Mark all as complete"),
      () => ul(
        { class: styles.todoList },
        filteredTodos(todos.val, filter.val).map(todo =>
          TodoItem({
            todo,
            textInputClass: styles.textInput,
            onChange: nextTodo => {
              todos.val = todos.val.map(item =>
                item.id === nextTodo.id ? nextTodo : item
              )
            },
          })
        )
      ),
      footer({ class: styles.footer },
        span({ class: styles.todoCount },
          () => {
            const activeCount = visibleTodos(todos.val).filter(todo => !todo.done).length
            return `${activeCount} item${activeCount === 1 ? "" : "s"} left`
          }
        ),
        () => ul({ class: styles.filters },
          li(
            a({
              href: "#/",
              class: `${styles.filterLink} ${filter.val === "all" ? styles.selected : ""}`,
              onclick: () => filter.val = "all",
            }, "All")
          ),
          li(
            a({
              href: "#/active",
              class: `${styles.filterLink} ${filter.val === "active" ? styles.selected : ""}`,
              onclick: () => filter.val = "active",
            }, "Active")
          ),
          li(
            a({
              href: "#/completed",
              class: `${styles.filterLink} ${filter.val === "completed" ? styles.selected : ""}`,
              onclick: () => filter.val = "completed",
            }, "Completed")
          ),
        ),
        () => visibleTodos(todos.val).some(todo => todo.done)
          ? button({ class: styles.clearCompleted, onclick: onClearCompleted }, "Clear completed")
          : "",
      ),
    ),
  )
}
