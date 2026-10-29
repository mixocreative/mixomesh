import { Fragment } from 'react';

/** A shortcut ("Ctrl+Shift+Z") drawn as key caps. */
export function KeyCaps({ shortcut }: { shortcut: string }) {
  return <>{shortcut.split('+').map((key, i) => <Fragment key={`${i}-${key}`}>{i > 0 && '+'}<kbd>{key}</kbd></Fragment>)}</>;
}
