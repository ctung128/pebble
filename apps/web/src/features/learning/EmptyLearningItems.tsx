import { Link } from "react-router";
import { Icon, type IconName } from "../../components/Icon.tsx";
import styles from "./EmptyLearningItems.module.css";

const STEPS: { icon: IconName; text: React.ReactNode }[] = [
  { icon: "play", text: "Open an episode from the Library and start listening." },
  {
    icon: "bookmark",
    text: (
      <>
        Save a line with its bookmark button, or press <kbd className={styles.key}>S</kbd>.
      </>
    ),
  },
  { icon: "download", text: "Review your saved lines here, then export them for Anki." },
];

/**
 * The Learning items page before anything is saved: a preview of what a saved line looks like,
 * the three steps to get one, and a way back to the Library.
 */
export function EmptyLearningItems() {
  return (
    <section className={styles.empty} aria-labelledby="empty-learning-title">
      {/* Decorative preview of a saved card, using a demo-001 line and its prepared translation. */}
      <div className={styles.preview} aria-hidden="true">
        <div className={styles.previewCard}>
          <p className={styles.previewZh} lang="zh-CN">
            原汁原味的语料，比课本香多了。
          </p>
          <p className={styles.previewEn}>Authentic material — way better than textbooks.</p>
          <span className={styles.previewSaved}>
            <Icon name="bookmarkFilled" size={18} />
          </span>
        </div>
      </div>

      <div className={styles.copy}>
        <h2 id="empty-learning-title" className={styles.title}>
          No learning items yet
        </h2>
        <p className={styles.message}>
          Lines you save while listening collect here, with their pinyin and English, ready to
          review or turn into flashcards.
        </p>
      </div>

      <ol className={styles.steps}>
        {STEPS.map((step, i) => (
          <li key={step.icon} className={styles.step}>
            <span className={styles.stepIcon}>
              <Icon name={step.icon} size={18} />
            </span>
            <span className={styles.stepText}>
              <span className={styles.visuallyHidden}>Step {i + 1}: </span>
              {step.text}
            </span>
          </li>
        ))}
      </ol>

      <Link to="/" className={styles.action}>
        Browse the Library
      </Link>
    </section>
  );
}
