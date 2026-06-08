import { useAppStore } from '../stores/appStore'
import HeroSection from '../components/HeroSection'
import MediaRow from '../components/MediaRow'
import { MOCK_HERO_MOVIE, MOCK_TRENDING, MOCK_POPULAR_SHOWS } from '../data/mock'

export default function HomePage() {
  const homeRows = useAppStore((s) => s.homeRows)

  return (
    <div className="pb-12">
      {homeRows
        .filter((row) => row.enabled)
        .sort((a, b) => a.order - b.order)
        .map((row) => {
          if (row.layout === 'hero') {
            return (
              <HeroSection
                key={row.id}
                item={MOCK_HERO_MOVIE}
                type="movie"
              />
            )
          }

          if (row.layout === 'continue') {
            return null
          }

          let items = row.catalogId === 'mock-series' ? MOCK_POPULAR_SHOWS : MOCK_TRENDING

          return (
            <MediaRow
              key={row.id}
              title={row.title}
              items={items}
              layout={row.layout === 'landscape' ? 'landscape' : row.layout === 'list' ? 'list' : 'poster'}
            />
          )
        })}
    </div>
  )
}
