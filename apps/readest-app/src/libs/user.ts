import { getAPIBaseUrl } from '@/services/environment';
import { getUserID } from '@/utils/access';
import { fetchWithAuth } from '@/utils/fetch';
import { getBukshelfApiBaseUrl } from '@/services/runtimeConfig';

const LIBRARY_API_ENDPOINT = getAPIBaseUrl() + '/user/library';
const libraryEndpoint = () =>
  getBukshelfApiBaseUrl() ? `${getBukshelfApiBaseUrl()}/api/user/library` : LIBRARY_API_ENDPOINT;

export const deleteCloudLibrary = async () => {
  try {
    const userId = await getUserID();
    if (!userId) {
      throw new Error('Not authenticated');
    }

    await fetchWithAuth(libraryEndpoint(), {
      method: 'DELETE',
    });
  } catch (error) {
    console.error('Cloud library deletion failed:', error);
    throw new Error('Cloud library deletion failed');
  }
};
