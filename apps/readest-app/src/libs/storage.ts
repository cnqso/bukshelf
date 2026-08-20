import { getAPIBaseUrl, isWebAppPlatform } from '@/services/environment';
import { AppService } from '@/types/system';
import { getAccessToken, getUserID } from '@/utils/access';
import { fetchWithAuth } from '@/utils/fetch';
import { getBukshelfApiBaseUrl } from '@/services/runtimeConfig';
import {
  tauriUpload,
  tauriDownload,
  webUpload,
  webDownload,
  ProgressHandler,
  ProgressPayload,
} from '@/utils/transfer';

const API_ENDPOINTS = {
  upload: getAPIBaseUrl() + '/storage/upload',
  download: getAPIBaseUrl() + '/storage/download',
  delete: getAPIBaseUrl() + '/storage/delete',
  stats: getAPIBaseUrl() + '/storage/stats',
  list: getAPIBaseUrl() + '/storage/list',
  purge: getAPIBaseUrl() + '/storage/purge',
};

const bukshelfFilesUrl = () => `${getBukshelfApiBaseUrl()}/api/files`;
const authHeaders = async () => {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');
  return { Authorization: `Bearer ${token}` };
};

export const createProgressHandler = (
  totalFiles: number,
  completedFilesRef: { count: number },
  onProgress?: ProgressHandler,
) => {
  return (progress: ProgressPayload) => {
    const fileProgress = progress.progress / progress.total;
    const overallProgress = ((completedFilesRef.count + fileProgress) / totalFiles) * 100;

    if (onProgress) {
      onProgress({
        progress: overallProgress,
        total: 100,
        transferSpeed: progress.transferSpeed,
      });
    }
  };
};

export const uploadFile = async (
  file: File,
  fileFullPath: string,
  onProgress?: ProgressHandler,
  bookHash?: string,
  temp = false,
  media?: string,
) => {
  try {
    // Temporary/public media uploads still belong to the legacy sharing path.
    // Private library objects now stream directly to Bun: no presigned URL,
    // object-storage SDK, or separate confirmation request.
    if (!temp && !media && getBukshelfApiBaseUrl()) {
      const query = new URLSearchParams({ path: file.name });
      if (bookHash) query.set('bookHash', bookHash);
      const uploadUrl = `${bukshelfFilesUrl()}?${query}`;
      const headers = await authHeaders();
      if (isWebAppPlatform()) {
        await webUpload(file, uploadUrl, onProgress, headers);
      } else {
        await tauriUpload(
          uploadUrl,
          fileFullPath,
          'PUT',
          onProgress,
          new Map(Object.entries(headers)),
        );
      }
      return undefined;
    }

    const response = await fetchWithAuth(API_ENDPOINTS.upload, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: file.name,
        fileSize: file.size,
        bookHash,
        temp,
        media,
      }),
    });

    const { uploadUrl, downloadUrl }: { uploadUrl: string; downloadUrl?: string } =
      await response.json();
    if (isWebAppPlatform()) {
      await webUpload(file, uploadUrl, onProgress);
    } else {
      await tauriUpload(uploadUrl, fileFullPath, 'PUT', onProgress);
    }
    return temp || media ? downloadUrl : undefined;
  } catch (error) {
    console.error('File upload failed:', error);
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('File upload failed');
  }
};

// Replica file upload. Reuses the books-style signed-URL path so 1+ GB
// dictionaries bypass the CF Workers body limit (per plan-eng-review §1).
// `cfp` is the cloud file path (key under the user's prefix); it must
// already contain the kind + replica-id prefix from CLOUD_REPLICAS_SUBDIR.
// Filenames are server-validated (see src/libs/replicaSchemas.ts:validateFilename).
export const uploadReplicaFile = async (
  file: File,
  fileFullPath: string,
  cfp: string,
  replicaKind: string,
  replicaId: string,
  onProgress?: ProgressHandler,
) => {
  try {
    if (getBukshelfApiBaseUrl()) {
      const query = new URLSearchParams({
        path: cfp,
        replicaKind,
        replicaId,
      });
      const uploadUrl = `${bukshelfFilesUrl()}?${query}`;
      const headers = await authHeaders();
      if (isWebAppPlatform()) {
        await webUpload(file, uploadUrl, onProgress, headers);
      } else {
        await tauriUpload(
          uploadUrl,
          fileFullPath,
          'PUT',
          onProgress,
          new Map(Object.entries(headers)),
        );
      }
      return;
    }

    const response = await fetchWithAuth(API_ENDPOINTS.upload, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: cfp,
        fileSize: file.size,
        replicaKind,
        replicaId,
        temp: false,
      }),
    });

    const { uploadUrl }: { uploadUrl: string } = await response.json();
    if (isWebAppPlatform()) {
      await webUpload(file, uploadUrl, onProgress);
    } else {
      await tauriUpload(uploadUrl, fileFullPath, 'PUT', onProgress);
    }
  } catch (error) {
    console.error('Replica file upload failed:', error);
    if (error instanceof Error) throw error;
    throw new Error('Replica file upload failed');
  }
};

export const batchGetDownloadUrls = async (files: { lfp: string; cfp: string }[]) => {
  try {
    if (getBukshelfApiBaseUrl()) {
      const headers = await authHeaders();
      return files.map((file) => ({
        ...file,
        downloadUrl: `${bukshelfFilesUrl()}?path=${encodeURIComponent(file.cfp)}`,
        headers,
      }));
    }
    const userId = await getUserID();
    if (!userId) throw new Error('Not authenticated');
    const filePaths = files.map((file) => file.cfp);
    const fileKeys = filePaths.map((path) => `${userId}/${path}`);
    const response = await fetchWithAuth(`${API_ENDPOINTS.download}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fileKeys }),
    });

    const { downloadUrls } = await response.json();
    return files.map((file) => {
      const fileKey = `${userId}/${file.cfp}`;
      return {
        lfp: file.lfp,
        cfp: file.cfp,
        downloadUrl: downloadUrls[fileKey],
        headers: undefined,
      };
    });
  } catch (error) {
    console.error('Batch get download URLs failed:', error);
    throw new Error('Batch get download URLs failed');
  }
};

type DownloadFileParams = {
  appService: AppService;
  dst: string;
  cfp: string;
  url?: string;
  headers?: Record<string, string>;
  singleThreaded?: boolean;
  skipSslVerification?: boolean;
  onProgress?: ProgressHandler;
};

export const downloadFile = async ({
  appService,
  dst,
  cfp,
  url,
  headers,
  singleThreaded,
  skipSslVerification,
  onProgress,
}: DownloadFileParams) => {
  try {
    let downloadUrl = url;
    let downloadHeaders = headers;
    if (!downloadUrl) {
      if (getBukshelfApiBaseUrl()) {
        downloadUrl = `${bukshelfFilesUrl()}?path=${encodeURIComponent(cfp)}`;
        downloadHeaders = await authHeaders();
      } else {
        const userId = await getUserID();
        if (!userId) throw new Error('Not authenticated');
        const fileKey = `${userId}/${cfp}`;
        const response = await fetchWithAuth(
          `${API_ENDPOINTS.download}?fileKey=${encodeURIComponent(fileKey)}`,
          { method: 'GET' },
        );
        const body = (await response.json()) as { downloadUrl?: string };
        downloadUrl = body.downloadUrl;
      }
    }

    if (!downloadUrl) {
      throw new Error('No download URL available');
    }

    if (isWebAppPlatform()) {
      const { headers: responseHeaders, blob } = await webDownload(
        downloadUrl,
        onProgress,
        downloadHeaders,
      );
      await appService.writeFile(dst, 'None', await blob.arrayBuffer());
      return responseHeaders;
    } else {
      return await tauriDownload(
        downloadUrl,
        dst,
        onProgress,
        downloadHeaders,
        undefined,
        singleThreaded,
        skipSslVerification,
      );
    }
  } catch (error) {
    console.error(`File '${dst}' download failed:`, error);
    throw error;
  }
};

export const deleteFile = async (filePath: string) => {
  try {
    if (getBukshelfApiBaseUrl()) {
      await fetchWithAuth(`${bukshelfFilesUrl()}?path=${encodeURIComponent(filePath)}`, {
        method: 'DELETE',
      });
      return;
    }
    const userId = await getUserID();
    if (!userId) throw new Error('Not authenticated');
    const fileKey = `${userId}/${filePath}`;
    await fetchWithAuth(`${API_ENDPOINTS.delete}?fileKey=${encodeURIComponent(fileKey)}`, {
      method: 'DELETE',
    });
  } catch (error) {
    // Best-effort cloud cleanup: removing the remote copy is non-critical and
    // callers dispatch this without awaiting, so throwing here surfaces as an
    // unhandled promise rejection (Sentry READEST-5). Log and swallow instead.
    console.warn('File deletion failed:', error);
  }
};

export interface StorageStats {
  totalFiles: number;
  totalSize: number;
  usage: number;
  quota: number;
  usagePercentage: number;
  byBookHash: Array<{
    bookHash: string | null;
    fileCount: number;
    totalSize: number;
  }>;
}

export const getStorageStats = async (): Promise<StorageStats> => {
  try {
    const endpoint = getBukshelfApiBaseUrl() ? `${bukshelfFilesUrl()}/stats` : API_ENDPOINTS.stats;
    const response = await fetchWithAuth(endpoint, {
      method: 'GET',
    });

    return await response.json();
  } catch (error) {
    console.error('Get storage stats failed:', error);
    throw new Error('Get storage stats failed');
  }
};

export interface FileRecord {
  file_key: string;
  file_size: number;
  book_hash: string | null;
  replica_kind: string | null;
  replica_id: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface ListFilesParams {
  page?: number;
  pageSize?: number;
  sortBy?: 'created_at' | 'updated_at' | 'file_size' | 'file_key';
  sortOrder?: 'asc' | 'desc';
  bookHash?: string;
  search?: string;
}

interface ListFilesResponse {
  files: FileRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const listFiles = async (params?: ListFilesParams): Promise<ListFilesResponse> => {
  try {
    const queryParams = new URLSearchParams();

    if (params?.page) queryParams.set('page', params.page.toString());
    if (params?.pageSize) queryParams.set('pageSize', params.pageSize.toString());
    if (params?.sortBy) queryParams.set('sortBy', params.sortBy);
    if (params?.sortOrder) queryParams.set('sortOrder', params.sortOrder);
    if (params?.bookHash) queryParams.set('bookHash', params.bookHash);
    if (params?.search) queryParams.set('search', params.search);

    const endpoint = getBukshelfApiBaseUrl() ? bukshelfFilesUrl() : API_ENDPOINTS.list;
    const url = queryParams.toString() ? `${endpoint}?${queryParams.toString()}` : endpoint;

    const response = await fetchWithAuth(url, {
      method: 'GET',
    });

    return await response.json();
  } catch (error) {
    console.error('List files failed:', error);
    throw new Error('List files failed');
  }
};

interface PurgeFilesResult {
  success: string[];
  failed: Array<{ fileKey: string; error: string }>;
  deletedCount: number;
  failedCount: number;
}

export const purgeFiles = async (
  filePathsOrKeys: string[],
  isFileKeys = false,
): Promise<PurgeFilesResult> => {
  try {
    if (getBukshelfApiBaseUrl()) {
      const response = await fetchWithAuth(bukshelfFilesUrl(), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: filePathsOrKeys }),
      });
      return await response.json();
    }

    let fileKeys: string[];
    if (isFileKeys) fileKeys = filePathsOrKeys;
    else {
      const userId = await getUserID();
      if (!userId) throw new Error('Not authenticated');
      fileKeys = filePathsOrKeys.map((path) => `${userId}/${path}`);
    }

    const response = await fetchWithAuth(API_ENDPOINTS.purge, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fileKeys }),
    });

    return await response.json();
  } catch (error) {
    console.error('Purge files failed:', error);
    throw new Error('Purge files failed');
  }
};
