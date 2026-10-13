import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { BookSpinesBand } from "./motion";
import "./notFound.css";

/** 404 for unknown login and admin addresses: a gap on the shelf and one way back to /login. */
export function NotFoundPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  return (
    <section className={`qa-not-found ${embedded ? "is-embedded" : ""}`} aria-labelledby="not-found-title">
      <BookSpinesBand count={embedded ? 18 : 28} height={40} className="is-small qa-not-found-shelf" />
      <p className="qa-not-found-code mono" aria-hidden="true">404</p>
      <h1 id="not-found-title">{t("notFound.title")}</h1>
      <p className="qa-not-found-body">{t("notFound.body")}</p>
      <Link className="qa-button qa-button-primary qa-not-found-action" to="/login" replace>{t("notFound.back")}</Link>
    </section>
  );
}
