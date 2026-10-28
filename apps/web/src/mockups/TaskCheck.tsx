/** The round task box: a ring while open, a filled disc once done. */
export function TaskCheck({
  done = false,
  size = 14,
}: {
  done?: boolean | undefined;
  size?: number;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block flex-none rounded-full ${
        done ? 'bg-primary' : 'border-[1.5px] border-hairline-strong'
      }`}
      style={{ height: size, width: size }}
    />
  );
}
