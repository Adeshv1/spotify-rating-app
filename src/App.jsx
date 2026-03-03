import { useEffect, useState } from 'react'
import './App.css'

function App() {
  const [loading, setLoading] = useState(true)
  const [loggedIn, setLoggedIn] = useState(false)
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    ;(async () => {
      try {
        const sessionRes = await fetch('/api/session')
        const session = await sessionRes.json()

        if (!session?.loggedIn) {
          setLoggedIn(false)
          return
        }

        setLoggedIn(true)
        const meRes = await fetch('/api/me')
        if (meRes.ok) setProfile(await meRes.json())
      } catch (e) {
        setError(e?.message || 'Something went wrong')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  async function logout() {
    await fetch('/auth/logout', { method: 'POST' })
    window.location.reload()
  }

  if (loading) {
    return (
      <div className="card">
        <p>Loading…</p>
      </div>
    )
  }

  return (
    <>
      <div className="card">
        <h1>Spotify Rating App</h1>
        {error ? <p>{error}</p> : null}

        {!loggedIn ? (
          <>
            <p>Log in to Spotify to continue.</p>
            <a className="read-the-docs" href="/auth/login">
              Log in with Spotify
            </a>
          </>
        ) : (
          <>
            <p>
              Logged in{profile?.display_name ? ` as ${profile.display_name}` : ''}.
            </p>
            <button onClick={logout}>Log out</button>
          </>
        )}
      </div>
    </>
  )
}

export default App
