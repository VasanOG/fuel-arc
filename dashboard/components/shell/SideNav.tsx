"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import styles from "./shell.module.css";

/**
 * Fuel's navigation.
 *
 * All eight destinations have real pages behind them. The `built` flag stays on
 * NavItem rather than being deleted: it is what kept every one of these links
 * from pointing at a 404 while its page did not exist yet, and its own comment
 * predicted the next destination would need it — which Earning, added in 6B-3,
 * duly did.
 *
 * The grouping carries real information: the first group is money moving and
 * the people who govern it, the second is where that becomes a record and how
 * Fuel connects to the systems around it.
 *
 * Earning sits in Operations, after the Activity Ledger, because it is money
 * moving — not a record of it and not a setup step. Its position after the
 * ledger is deliberate too: the ledger is where an operator sees that revenue
 * arrived, and this is where they go to ask why it did or did not.
 */

interface NavItem {
  name: string;
  href: string;
  /** False until a route exists. Renders as text, not a link. */
  built: boolean;
}

const SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "Operations",
    items: [
      { name: "Overview", href: "/", built: true },
      { name: "Agents", href: "/agents", built: true },
      { name: "Activity Ledger", href: "/activity", built: true },
      { name: "Earning", href: "/earning", built: true },
      { name: "Approvals", href: "/approvals", built: true },
    ],
  },
  {
    label: "Records & setup",
    items: [
      { name: "Accounting", href: "/accounting", built: true },
      { name: "Integrations", href: "/integrations", built: true },
      { name: "Developer", href: "/developer", built: true },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/**
 * `children` is the foot of the nav — who is signed in, then what Fuel is
 * pointed at — both resolved on the server and handed down. They sit below the
 * sections and outside the mobile disclosure, so neither answer becomes less
 * urgent because the navigation is collapsed.
 *
 * The order is deliberate: the person comes first, because from Stage 3 a
 * decision made in this product is recorded against them, and "who am I acting
 * as" is the question that changes what a click MEANS. The environment answers
 * what a click COSTS, and sits directly beneath it.
 */
export function SideNav({ children }: { children?: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // The mobile disclosure closes itself on navigation. Leaving it open would
  // cover the page the operator just asked for.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <nav className={styles.nav} aria-label="Sections">
      <div className={styles.brandRow}>
        <Link href="/" className={styles.brand}>
          Fuel
        </Link>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls="nav-sections"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Close" : "Menu"}
        </button>
      </div>

      <div
        id="nav-sections"
        className={open ? `${styles.sections} ${styles.sectionsOpen}` : styles.sections}
      >
        {SECTIONS.map((section) => (
          <div key={section.label} className={styles.group}>
            <p className={styles.groupLabel}>{section.label}</p>
            <ul className={styles.list}>
              {section.items.map((item) => (
                <li key={item.name}>
                  {item.built ? (
                    <Link
                      href={item.href}
                      className={
                        isActive(pathname, item.href)
                          ? `${styles.item} ${styles.itemActive}`
                          : styles.item
                      }
                      aria-current={isActive(pathname, item.href) ? "page" : undefined}
                    >
                      {item.name}
                    </Link>
                  ) : (
                    <span className={`${styles.item} ${styles.itemSoon}`}>
                      {item.name}
                      <span className={styles.soon}>soon</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {children && <div className={styles.navFoot}>{children}</div>}
    </nav>
  );
}
