import HomePageContent from '@/components/HomePageContent';
import { getServerRuntimeConfig } from '@/services/runtimeConfig';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  return (
    <HomePageContent
      publicLibraryEnabled={getServerRuntimeConfig().publicLibraryEnabled === true}
    />
  );
}
