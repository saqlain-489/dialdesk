import { useState } from 'react'
import { api } from '../api'
import type { Org, OrgSummary } from '../types'

// Only rendered for someone in more than one workspace (the owner); a caller never learns
// another workspace exists. Switching reloads the page so nothing from the previous
// workspace (Twilio device, queued state, caches) survives.
export function WorkspaceSwitcher({ current, orgs, disabled }: { current: Org; orgs: OrgSummary[]; disabled: boolean }) {
  const [busy, setBusy] = useState(false)

  return (
    <select
      className="workspace-switcher"
      aria-label="Workspace"
      value={current.id}
      disabled={disabled || busy}
      title={disabled ? 'Finish the call first' : 'Switch workspace'}
      onChange={async (e) => {
        setBusy(true)
        try {
          await api.switchOrg(e.target.value)
          window.location.reload()
        } catch {
          setBusy(false)
        }
      }}
    >
      {orgs.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  )
}
