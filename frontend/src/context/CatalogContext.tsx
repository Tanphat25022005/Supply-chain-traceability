import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { catalogApi, CatalogView, ReferenceData } from '../api/client'
import { Catalog } from '../domain/catalog'
import { useAuth } from './AuthContext'

interface CatalogState {
  /** Undefined until the first load completes. */
  catalog?: Catalog
  error: boolean
  /** Re-fetch after an admin changed the tenant's catalog or reference data. */
  reload: () => void
}

const CatalogCtx = createContext<CatalogState>({ error: false, reload: () => undefined })

/**
 * Loads the catalog once: the public platform catalog for anonymous pages,
 * the tenant's view (its own product types and units) plus the reference
 * data once someone is signed in.
 */
export function CatalogProvider({ children }: { children: ReactNode }) {
  const { actor, isLoading } = useAuth()
  const [view, setView] = useState<CatalogView>()
  const [reference, setReference] = useState<ReferenceData>()
  const [error, setError] = useState(false)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (isLoading) return
    let cancelled = false
    setError(false)
    const load = actor
      ? Promise.all([catalogApi.tenant(), catalogApi.reference().catch(() => undefined)])
      : Promise.all([catalogApi.public(), Promise.resolve(undefined)])
    load
      .then(([v, r]) => {
        if (cancelled) return
        setView(v)
        setReference(r)
      })
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [actor?.id, isLoading, version]) // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(() => setVersion((v) => v + 1), [])
  const catalog = useMemo(() => (view ? new Catalog(view, reference) : undefined), [view, reference])
  return <CatalogCtx.Provider value={{ catalog, error, reload }}>{children}</CatalogCtx.Provider>
}

export function useCatalog(): CatalogState {
  return useContext(CatalogCtx)
}
