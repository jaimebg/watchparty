import { Library } from './pages/Library'
import { Room } from './pages/Room'

export function App() {
  const m = location.pathname.match(/^\/room\/([\w-]+)/)
  return m ? <Room token={m[1]} /> : <Library />
}
