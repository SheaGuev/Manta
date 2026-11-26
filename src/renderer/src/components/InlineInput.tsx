import { useState } from 'react'

interface InlineInputProps {
  depth: number
  placeholder: string
  onSubmit: (value: string) => Promise<void>
  onCancel: () => void
}

export function InlineInput({ depth, placeholder, onSubmit, onCancel }: InlineInputProps): React.JSX.Element {
  const [value, setValue] = useState('')
  return (
    <form
      className="tree-row"
      style={{ '--depth': depth }}
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim()) void onSubmit(value.trim())
      }}
    >
      <input
        className="inline-input"
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        onBlur={() => !value.trim() && onCancel()}
      />
    </form>
  )
}
