/**
 * How many of the change's files are marked viewed, the way GitHub reports it
 * on a pull request. A file is the unit the reviewer marks, so it is the unit
 * the count is in, whatever the walkthrough grouped those files into.
 */
export function ViewedProgress({ total, viewed }: { total: number; viewed: number }) {
  if (total === 0) {
    return null;
  }

  const done = Math.min(viewed, total);
  return (
    <span
      className={`viewed-progress${done === total ? ' complete' : ''}`}
      title={`${done} of ${total} files marked viewed`}
    >
      <span
        aria-label="Files viewed"
        aria-valuemax={total}
        aria-valuemin={0}
        aria-valuenow={done}
        className="viewed-progress-bar"
        role="progressbar"
      >
        <span className="viewed-progress-fill" style={{ width: `${(done / total) * 100}%` }} />
      </span>
      <span className="viewed-progress-label">
        <span className="viewed-progress-count">{done}</span> / {total} viewed
      </span>
    </span>
  );
}
