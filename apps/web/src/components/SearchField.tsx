import { useId, useRef } from "react";
import { Icon } from "./Icon.tsx";
import styles from "./SearchField.module.css";

interface SearchFieldProps {
  /** Visually hidden label, e.g. "Search episodes". */
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}

/**
 * Design system SearchField: a filled search input with the magnifier inside, a visible Clear
 * button while there's text, and Escape to clear. Purely local; it never makes a request.
 */
export function SearchField({ label, placeholder, value, onChange }: SearchFieldProps) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const clear = () => {
    onChange("");
    field.current?.focus();
  };
  return (
    <div className={styles.search}>
      <label htmlFor={id} className={styles.visuallyHidden}>
        {label}
      </label>
      <span className={styles.icon}>
        <Icon name="search" size={16} />
      </span>
      <input
        ref={field}
        id={id}
        type="search"
        className={styles.field}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            onChange("");
          }
        }}
      />
      {value ? (
        <button type="button" className={styles.clear} aria-label="Clear search" onClick={clear}>
          <Icon name="close" size={16} />
        </button>
      ) : null}
    </div>
  );
}
