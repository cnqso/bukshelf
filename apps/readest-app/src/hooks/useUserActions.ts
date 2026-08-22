import { useRouter } from 'next/navigation';
import { useEnv } from '@/context/EnvContext';
import { useAuth } from '@/context/AuthContext';
import { deleteAllBooks } from '@/services/deleteLibraryService';
import { useLibraryStore } from '@/store/libraryStore';
import { eventDispatcher } from '@/utils/event';
import { saveSysSettings } from '@/helpers/settings';
import { navigateToLibrary } from '@/utils/nav';

export const useUserActions = () => {
  const router = useRouter();
  const { envConfig, appService } = useEnv();
  const { logout } = useAuth();

  const handleLogout = () => {
    logout();
    saveSysSettings(envConfig, 'keepLogin', false);
    navigateToLibrary(router);
  };

  const handleDeleteAllBooks = async (successMessage: string, errorMessage: string) => {
    if (!appService) return;
    try {
      await deleteAllBooks(appService);
      useLibraryStore.getState().setLibrary([]);
      eventDispatcher.dispatch('toast', {
        type: 'success',
        message: successMessage,
      });
    } catch (error) {
      console.error('Error deleting all books:', error);
      eventDispatcher.dispatch('toast', {
        type: 'error',
        message: errorMessage,
      });
    }
  };

  return {
    handleLogout,
    handleDeleteAllBooks,
  };
};
