import type { ReactNode } from "react";
import styles from "./shell.module.css";

/**
 * The masthead every page shares.
 *
 * The 2px rule beneath it is the same weight that closes a journal entry's
 * header and opens its total row. One rule hierarchy across the product: 2px
 * separates a document from its contents, 1px separates contents from each
 * other.
 */
export function PageHeader({
  title,
  description,
  aside,
}: {
  title: string;
  description?: string;
  /** Right-aligned context — environment, connection state. Never an action. */
  aside?: ReactNode;
}) {
  return (
    <header className={styles.header}>
      <div>
        <h1 className={styles.title}>{title}</h1>
        {description && <p className={styles.description}>{description}</p>}
      </div>
      {aside}
    </header>
  );
}
