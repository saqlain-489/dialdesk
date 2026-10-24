import { Fragment } from 'react'

export function Highlight({ text, term }: { text: string; term?: string }) {
  const needle = term?.trim()
  if (!needle) return <>{text}</>
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>,
      )}
    </>
  )
}
