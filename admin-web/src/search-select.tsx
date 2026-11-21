import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";

/** One choice in a SearchSelect. `keys` holds extra words to match (other languages, codes); `pinned` stays visible whatever is typed. */
export type SearchOption = { value: string; label: string; detail?: string; group?: string; keys?: string; pinned?: boolean };

const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").replace(/ё/g, "е").toLowerCase();
const tokens = (query: string) => fold(query).split(/[\s,/·()]+/u).filter(Boolean);

/** Options whose text holds every typed word, best first inside each group: whole words (codes), then word starts, then mid-word hits. */
export function filterOptions(options: SearchOption[], query: string): SearchOption[] {
  const words = tokens(query);
  if (!words.length) return options;
  const scored: Array<[SearchOption, number, number]> = [];
  options.forEach((option, index) => {
    if (option.pinned) { scored.push([option, 3, index]); return; }
    const text = fold(`${option.label} ${option.detail || ""} ${option.keys || ""}`);
    if (!words.every((word) => text.includes(word))) return;
    const parts = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const rank = words.every((word) => parts.includes(word)) ? 0 : words.every((word) => parts.some((part) => part.startsWith(word))) ? 1 : 2;
    scored.push([option, rank, index]);
  });
  const groupOrder = new Map<string | undefined, number>();
  for (const option of options) if (!groupOrder.has(option.group)) groupOrder.set(option.group, groupOrder.size);
  return scored.sort((a, b) => (a[0].pinned ? 1 : 0) - (b[0].pinned ? 1 : 0) || groupOrder.get(a[0].group)! - groupOrder.get(b[0].group)! || a[1] - b[1] || a[2] - b[2]).map(([option]) => option);
}

/**
 * A select you can type into: focus it and type a city, country or code in any language to narrow the list.
 * Arrow keys move, Enter picks, Escape closes. The list is portalled and position:fixed: the sticky form panel never
 * clips it, and a click on an option is not also a click on the surrounding <label>.
 */
export function SearchSelect({ options, value, onChange, placeholder, searchPlaceholder, emptyText, required, ariaLabel }: {
  options: SearchOption[]; value: string; onChange: (value: string) => void; placeholder: string; searchPlaceholder: string; emptyText: string; required?: boolean; ariaLabel?: string;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number } | null>(null);
  const selected = options.find((option) => option.value === value);
  const shown = useMemo(() => open ? filterOptions(options, query) : [], [open, options, query]);
  const matches = shown.filter((option) => !option.pinned).length;

  function place() {
    const anchor = inputRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const below = window.innerHeight - anchor.bottom - 12, above = anchor.top - 12;
    const up = below < 220 && above > below;
    const maxHeight = Math.min(340, up ? above : below);
    // Opening upwards, pin the list's bottom edge to the field so a short result list still sits right above it.
    setBox({ ...(up ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }), left: anchor.left, width: anchor.width, maxHeight });
  }
  function show() {
    if (open) return;
    setQuery("");
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  }
  function close() { setOpen(false); setQuery(""); setBox(null); }
  function pick(option: SearchOption | undefined) {
    if (!option) return;
    onChange(option.value);
    close();
  }

  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const follow = (event: Event) => { if (!listRef.current?.contains(event.target as Node)) place(); };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", follow, true); window.removeEventListener("resize", place); };
  }, [open]);
  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active, box, shown]);

  function key(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { show(); return; }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => shown.length ? (index + step + shown.length) % shown.length : 0);
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      pick(shown[active]);
    } else if (event.key === "Escape" && open) {
      event.preventDefault(); event.stopPropagation();
      close();
    } else if (event.key === "Tab" && open) {
      close();
    }
  }

  return <div className="search-select">
    <input
      ref={inputRef}
      role="combobox"
      aria-label={ariaLabel}
      aria-expanded={open}
      aria-controls={`${id}-list`}
      aria-autocomplete="list"
      aria-activedescendant={open && shown[active] ? `${id}-${active}` : undefined}
      autoComplete="off"
      spellCheck={false}
      required={required}
      value={open ? query : selected ? (selected.detail ? `${selected.label} · ${selected.detail}` : selected.label) : ""}
      placeholder={open ? searchPlaceholder : placeholder}
      onFocus={show}
      onClick={show}
      onBlur={close}
      onChange={(event) => { setQuery(event.target.value); setActive(0); if (!open) setOpen(true); }}
      onKeyDown={key}
    />
    <span className="search-select-icon"><Icon name={open ? "search" : "chevron"} size={16} /></span>
    {open && createPortal(<div
      ref={listRef}
      id={`${id}-list`}
      className="search-select-list"
      role="listbox"
      style={box || { top: -9999, left: -9999 }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {!matches && <p className="search-select-empty">{emptyText}</p>}
      {shown.map((option, index) => {
        const heading = option.group && !option.pinned && option.group !== shown[index - 1]?.group ? option.group : null;
        return <div key={option.value} role="presentation">
          {heading && <div className="search-select-group" role="presentation">{heading}</div>}
          <div
            id={`${id}-${index}`}
            data-index={index}
            role="option"
            aria-selected={option.value === value}
            className={`search-select-option${index === active ? " active" : ""}${option.pinned ? " pinned" : ""}`}
            onMouseMove={() => { if (index !== active) setActive(index); }}
            onClick={() => pick(option)}
          >
            <span>{option.label}</span>
            {option.detail && <small>{option.detail}</small>}
            {option.value === value && <Icon name="check" size={15} />}
          </div>
        </div>;
      })}
    </div>, document.body)}
  </div>;
}
