import van from "https://cdn.jsdelivr.net/npm/vanjs-core@1.6.0/src/van.js"

const {button, div, p, strong} = van.tags

const logDom = document.getElementById("log")
const log = text => logDom.textContent += text + "\n"

const Counter = ({label, init = 0, className = "counter client"}) => {
  const count = van.state(init)

  return div(
    {
      class: className,
      "data-count": count,
    },
    button({onclick: () => --count.val}, "-"),
    strong(label, ": ", count),
    button({onclick: () => ++count.val}, "+"),
  )
}

log("Before JS:")
log("document already has #ssr-counter from index.html")

van.add(
  document.getElementById("client-only"),
  Counter({label: "Client-only count", init: 0}),
)

log("")
log("van.add(target, Counter(...)):")
log("append a brand new Counter into #client-only")

const oldDom = document.getElementById("ssr-counter")

van.hydrate(oldDom, dom => Counter({
  label: "Hydrated count",
  init: Number(dom.dataset.count),
  className: "counter client",
}))

log("")
log("van.hydrate(oldDom, dom => Counter(...)):")
log("read old DOM data-count = 5")
log("create a reactive Counter")
log("replace old #ssr-counter with the new reactive DOM")

log("")
log("Try clicking the two counters.")
