import { useEffect, useState, useCallback, useMemo } from "react";
import "./App.css";
import AuthScreen from "./components/AuthScreen";
import ConsoleHeader from "./components/ConsoleHeader";
import CatalogList from "./components/CatalogList";
import CatalogViewer from "./components/CatalogViewer";
import GeneratedFilesList from "./components/GeneratedFilesList";

const API_BASE_CANDIDATES = import.meta.env.DEV
  ? [
      "",
      "http://127.0.0.1:5100",
      "http://localhost:5100",
      "http://127.0.0.1:5000",
      "http://localhost:5000",
    ]
  : [""];
const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
};
const FULL_DETAILS_POLL_INTERVAL_MS = 2500;
const DAILY_REFRESH_POLL_INTERVAL_MS = 10000;
const FULL_DETAILS_PREVIEW_LIMIT = 1;

function parseResponseText(raw, fallbackMessage) {
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (_parseError) {
    const trimmed = raw.trim();
    const isHtmlResponse =
      trimmed.startsWith("<!DOCTYPE") ||
      trimmed.startsWith("<html") ||
      trimmed.startsWith("<body");
    const routeNotFoundMatch = trimmed.match(/Cannot (GET|POST) ([^\r\n<]+)/i);

    if (routeNotFoundMatch) {
      const [, method, route] = routeNotFoundMatch;
      throw new Error(
        `${fallbackMessage} ${method.toUpperCase()} ${route.trim()} was not found on the backend. Check that the correct API server is running and that the Vite proxy target matches it.`,
      );
    }

    if (isHtmlResponse) {
      throw new Error(
        `${fallbackMessage} The frontend received HTML instead of JSON. Check that the backend server is running and that the API proxy target points to the correct port.`,
      );
    }

    throw new Error(fallbackMessage);
  }
}

function buildApiUrl(path) {
  if (!path.startsWith("/")) {
    return `/${path}`;
  }

  return path;
}

function isRetryableApiParseError(message) {
  return (
    message.includes("received HTML instead of JSON") ||
    message.includes("was not found on the backend") ||
    message === "API returned an invalid response." ||
    message === "Products API returned an invalid response." ||
    message === "Product full details API returned an invalid response." ||
    message === "Failed to fetch"
  );
}

function isBlankPayload(data) {
  return (
    !data ||
    (typeof data === "object" &&
      !Array.isArray(data) &&
      Object.keys(data).length === 0)
  );
}

function formatFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) {
    return "-";
  }

  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds) / 1000));
  if (!Number.isFinite(totalSeconds)) {
    return "-";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (hours) {
    parts.push(`${hours}h`);
  }
  if (hours || minutes) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);

  return parts.join(" ");
}

async function fetchApi(path, options = {}, fallbackMessage) {
  const requestPath = buildApiUrl(path);
  const attempts = [];
  const { retryAcrossApiBases, ...fetchOptions } = options;
  const method = String(fetchOptions.method || "GET").toUpperCase();
  if (!fetchOptions.credentials) {
    fetchOptions.credentials = "include";
  }
  const canRetryAcrossApiBases =
    retryAcrossApiBases ?? (method === "GET" || method === "HEAD");

  for (const baseUrl of API_BASE_CANDIDATES) {
    const url = `${baseUrl}${requestPath}`;

    try {
      const response = await fetch(url, fetchOptions);
      const raw = await response.text();
      const data = parseResponseText(raw, fallbackMessage);

      if (!response.ok) {
        const message = data.message || fallbackMessage;

        if (response.status === 202) {
          return {
            response,
            data,
            baseUrl: baseUrl || "proxy",
          };
        }

        if (
          canRetryAcrossApiBases &&
          (response.status >= 500 || response.status === 404)
        ) {
          attempts.push({
            baseUrl: baseUrl || "proxy",
            message: `HTTP ${response.status}: ${message}`,
          });
          continue;
        }

        throw new Error(message);
      }

      return {
        response,
        data,
        baseUrl: baseUrl || "proxy",
      };
    } catch (error) {
      attempts.push({
        baseUrl: baseUrl || "proxy",
        message: error.message || fallbackMessage,
      });

      if (!isRetryableApiParseError(error.message || "")) {
        throw error;
      }

      if (!canRetryAcrossApiBases) {
        throw error;
      }
    }
  }

  const detail = attempts
    .map((attempt) => `${attempt.baseUrl}: ${attempt.message}`)
    .join(" | ");

  throw new Error(
    `${fallbackMessage} Tried proxy, port 5100, and port 5000. ${detail}`,
  );
}

function buildDownloadUrl(path) {
  const requestPath = buildApiUrl(path);
  const downloadBase = import.meta.env.VITE_API_DOWNLOAD_BASE || "";

  return `${downloadBase}${requestPath}`;
}

function compareVersionIdsDescending(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftIsNumber = Number.isFinite(leftNumber);
  const rightIsNumber = Number.isFinite(rightNumber);

  if (leftIsNumber && rightIsNumber) {
    return rightNumber - leftNumber;
  }

  return String(right).localeCompare(String(left), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

const DEFAULT_CATALOG_ID = "1920";

function getCatalogVersionIds(catalog) {
  if (!Array.isArray(catalog?.catalogVersions)) return [];
  return catalog.catalogVersions
    .map((version) => version?.id)
    .filter((id) => id !== undefined && id !== null)
    .sort(compareVersionIdsDescending);
}

function getVersionIds(catalog) {
  const versionIds = getCatalogVersionIds(catalog);
  return versionIds.length ? versionIds.join(", ") : "-";
}

function getVersionCount(catalog) {
  return getCatalogVersionIds(catalog).length;
}

function isCatalogActive(catalog) {
  return getVersionCount(catalog) > 0;
}

function App() {
  const [catalogs, setCatalogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [metadata, setMetadata] = useState(null);
  const [selectedCatalog, setSelectedCatalog] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState("all");
  const [activePage, setActivePage] = useState("catalogs");
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState(null);
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [authMode, setAuthMode] = useState("signin");
  const [signupPasswordConfirmation, setSignupPasswordConfirmation] =
    useState("");
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [fullProductDetails, setFullProductDetails] = useState([]);
  const [fullDetailsLoading, setFullDetailsLoading] = useState(false);
  const [fullDetailsError, setFullDetailsError] = useState("");
  const [fullDetailsMetadata, setFullDetailsMetadata] = useState(null);
  const [showFullDetails, setShowFullDetails] = useState(false);
  const [, setFullDetailsReady] = useState(false);
  const [fullDetailsCacheAvailable, setFullDetailsCacheAvailable] =
    useState(false);
  const [fullDetailsCacheStatus, setFullDetailsCacheStatus] =
    useState("missing");
  const [productJsonExportLoading] = useState(false);
  const [productJsonExportError] = useState("");
  const [productJsonExportResult] = useState(null);
  const [dailyRefreshStatus, setDailyRefreshStatus] = useState(null);
  const [dailyRefreshLoading, setDailyRefreshLoading] = useState(false);
  const [dailyRefreshManualRunActive, setDailyRefreshManualRunActive] =
    useState(false);
  const [dailyRefreshError, setDailyRefreshError] = useState("");
  const [dailyRefreshSelectionSaving, setDailyRefreshSelectionSaving] =
    useState(false);
  const [selectedDailyRefreshCatalogIds, setSelectedDailyRefreshCatalogIds] =
    useState([]);
  const [dailyRefreshSelectionOptions, setDailyRefreshSelectionOptions] =
    useState({});
  const [dailyRefreshSelectionSavedAt, setDailyRefreshSelectionSavedAt] =
    useState("");
  const [dailyRefreshSearchTerm, setDailyRefreshSearchTerm] = useState("");
  const [dailyRefreshCatalogFilter, setDailyRefreshCatalogFilter] =
    useState("all");
  const [dailyRefreshTick, setDailyRefreshTick] = useState(Date.now());
  const [lastGeneratedFilesRefreshKey, setLastGeneratedFilesRefreshKey] =
    useState("");
  const [generatedFiles, setGeneratedFiles] = useState(null);
  const [generatedFilesLoading, setGeneratedFilesLoading] = useState(false);
  const [generatedFilesError, setGeneratedFilesError] = useState("");

  const loadCatalogs = async (force = false) => {
    try {
      setLoading(true);
      setError("");

      const { response, data } = force
        ? await fetchApi(
            "/api/catalogs/refresh?lang=en-US",
            {
              method: "POST",
              headers: DEFAULT_HEADERS,
              body: JSON.stringify({ lang: "en-US" }),
            },
            "API returned an invalid response.",
          )
        : await fetchApi(
            "/api/catalogs?lang=en-US",
            {},
            "API returned an invalid response.",
          );

      if (!response.ok) {
        throw new Error(data.message || "Failed to fetch catalogs.");
      }

      const list = Array.isArray(data) ? data : data.items || [];
      const defaultCatalog =
        list.find((catalog) => String(catalog.id) === DEFAULT_CATALOG_ID) ||
        list[0] ||
        null;

      setCatalogs(list);
      setMetadata(data.metadata || null);
      setSelectedCatalog((currentSelectedCatalog) => {
        if (!list.length) {
          return null;
        }

        if (!currentSelectedCatalog) {
          return defaultCatalog;
        }

        return (
          list.find((catalog) => catalog.id === currentSelectedCatalog.id) ||
          defaultCatalog
        );
      });
    } catch (err) {
      setError(err.message || "Unexpected error while loading catalogs.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCatalogs(false);
  }, []);

  const checkAuthStatus = useCallback(async () => {
    try {
      setAuthError("");
      const { data } = await fetchApi(
        "/api/auth/me",
        { credentials: "include" },
        "Failed to verify authentication status.",
      );
      setIsAuthenticated(true);
      setUser(data.user || null);
    } catch (_error) {
      setIsAuthenticated(false);
      setUser(null);
    } finally {
      setAuthLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuthStatus();
  }, [checkAuthStatus]);

  const handleLoginSubmit = async (event) => {
    event.preventDefault();
    setLoginSubmitting(true);
    setAuthError("");

    try {
      const { response, data } = await fetchApi(
        "/api/auth/login",
        {
          method: "POST",
          headers: DEFAULT_HEADERS,
          body: JSON.stringify({
            username: loginUsername,
            password: loginPassword,
          }),
        },
        "Login failed.",
      );

      if (!response.ok) {
        throw new Error(data.message || "Login failed.");
      }

      setIsAuthenticated(true);
      setUser(data.user || null);
      setLoginPassword("");
      setAuthError("");
      await loadCatalogs(false);
    } catch (error) {
      setAuthError(error.message || "Unable to login.");
      setIsAuthenticated(false);
      setUser(null);
    } finally {
      setLoginSubmitting(false);
    }
  };

  const handleSignupSubmit = async (event) => {
    event.preventDefault();
    setAuthError("");
    if (loginPassword !== signupPasswordConfirmation) {
      setAuthError("Passwords do not match.");
      return;
    }
    setLoginSubmitting(true);
    try {
      const { data } = await fetchApi(
        "/api/auth/signup",
        {
          method: "POST",
          headers: DEFAULT_HEADERS,
          body: JSON.stringify({
            username: loginUsername,
            password: loginPassword,
          }),
        },
        "Sign up failed.",
      );
      setIsAuthenticated(true);
      setUser(data.user || null);
      setLoginPassword("");
      setSignupPasswordConfirmation("");
      await loadCatalogs(false);
    } catch (error) {
      setAuthError(error.message || "Unable to create account.");
    } finally {
      setLoginSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetchApi(
        "/api/auth/logout",
        {
          method: "POST",
        },
        "Logout failed.",
      );
    } catch (_error) {
      // ignore logout errors
    } finally {
      setIsAuthenticated(false);
      setUser(null);
    }
  };

  const loadDailyRefreshStatus = useCallback(async () => {
    try {
      const { data } = await fetchApi(
        "/api/daily-refresh/status",
        {},
        "Failed to check daily refresh status.",
      );
      setDailyRefreshStatus(data);
      if (Array.isArray(data?.selectedCatalogIds)) {
        setSelectedDailyRefreshCatalogIds(data.selectedCatalogIds.map(String));
      }
      if (Array.isArray(data?.availableCatalogs)) {
        setDailyRefreshSelectionOptions(
          Object.fromEntries(
            data.availableCatalogs
              .filter((catalog) => catalog.selected)
              .map((catalog) => [
                String(catalog.id),
                {
                  versionStrategy: catalog.versionStrategy || "LATEST",
                  catalogVersionId: String(
                    catalog.selectedVersionId || catalog.latestVersionId || "",
                  ),
                },
              ]),
          ),
        );
      }
      setDailyRefreshSelectionSavedAt(data?.selectionUpdatedAt || "");
      if (!data?.running && data?.lastRun?.completedAt) {
        setDailyRefreshManualRunActive(false);
      }
      setDailyRefreshError("");
    } catch (error) {
      setDailyRefreshError(
        error.message || "Unable to check daily refresh status.",
      );
    }
  }, []);

  useEffect(() => {
    loadDailyRefreshStatus();
  }, [loadDailyRefreshStatus]);

  useEffect(() => {
    if (
      !dailyRefreshStatus?.running &&
      !dailyRefreshLoading &&
      !dailyRefreshManualRunActive
    ) {
      return undefined;
    }

    setDailyRefreshTick(Date.now());
    const intervalId = window.setInterval(() => {
      setDailyRefreshTick(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    dailyRefreshStatus?.running,
    dailyRefreshLoading,
    dailyRefreshManualRunActive,
  ]);

  useEffect(() => {
    if (
      !dailyRefreshStatus?.running &&
      !dailyRefreshLoading &&
      !dailyRefreshManualRunActive
    ) {
      return undefined;
    }

    const intervalId = window.setInterval(
      loadDailyRefreshStatus,
      DAILY_REFRESH_POLL_INTERVAL_MS,
    );

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    dailyRefreshStatus?.running,
    dailyRefreshLoading,
    dailyRefreshManualRunActive,
    loadDailyRefreshStatus,
  ]);

  const loadGeneratedFiles = useCallback(async () => {
    if (!selectedVersionId) {
      setGeneratedFiles(null);
      setGeneratedFilesError("");
      return;
    }

    try {
      setGeneratedFilesLoading(true);
      setGeneratedFilesError("");
      const { data } = await fetchApi(
        `/api/catalog-products/generated-files?catalogVersionId=${encodeURIComponent(selectedVersionId)}&lang=en-US&_=${Date.now()}`,
        {
          cache: "no-store",
        },
        "Failed to fetch generated files.",
      );
      setGeneratedFiles(data);
    } catch (error) {
      setGeneratedFiles(null);
      setGeneratedFilesError(
        error.message || "Unable to fetch generated files.",
      );
    } finally {
      setGeneratedFilesLoading(false);
    }
  }, [selectedVersionId]);

  useEffect(() => {
    loadGeneratedFiles();
  }, [loadGeneratedFiles]);

  useEffect(() => {
    const lastRun = dailyRefreshStatus?.lastRun;
    if (!lastRun?.completedAt || dailyRefreshStatus?.running) {
      return;
    }

    setDailyRefreshManualRunActive(false);

    const refreshKey = `${lastRun.startedAt || ""}|${lastRun.completedAt}`;
    if (refreshKey === lastGeneratedFilesRefreshKey) {
      return;
    }

    setLastGeneratedFilesRefreshKey(refreshKey);
    loadCatalogs(false);
    loadGeneratedFiles();
  }, [
    dailyRefreshStatus?.lastRun,
    dailyRefreshStatus?.running,
    lastGeneratedFilesRefreshKey,
    loadGeneratedFiles,
  ]);

  const filteredCatalogs = useMemo(
    () =>
      catalogs.filter((catalog) => {
        const name = catalog.name || catalog.title || "";
        const id = String(catalog.id || "");
        const searchValue = searchTerm.trim().toLowerCase();
        const matchesSearch =
          !searchValue ||
          name.toLowerCase().includes(searchValue) ||
          id.toLowerCase().includes(searchValue);

        const matchesStatus =
          activeFilter === "all" ||
          (activeFilter === "active" && isCatalogActive(catalog)) ||
          (activeFilter === "inactive" && !isCatalogActive(catalog));

        return matchesSearch && matchesStatus;
      }),
    [activeFilter, catalogs, searchTerm],
  );

  const activeCount = catalogs.filter((catalog) =>
    isCatalogActive(catalog),
  ).length;
  const inactiveCount = catalogs.length - activeCount;

  useEffect(() => {
    if (!filteredCatalogs.length) {
      setSelectedCatalog(null);
      return;
    }

    setSelectedCatalog((currentSelectedCatalog) => {
      if (!currentSelectedCatalog) {
        return (
          filteredCatalogs.find(
            (catalog) => String(catalog.id) === DEFAULT_CATALOG_ID,
          ) || filteredCatalogs[0]
        );
      }

      return (
        filteredCatalogs.find(
          (catalog) => catalog.id === currentSelectedCatalog.id,
        ) ||
        filteredCatalogs.find(
          (catalog) => String(catalog.id) === DEFAULT_CATALOG_ID,
        ) ||
        filteredCatalogs[0]
      );
    });
  }, [filteredCatalogs]);

  useEffect(() => {
    const versionIds = selectedCatalog
      ? getCatalogVersionIds(selectedCatalog)
      : [];
    const nextVersionId = versionIds[0] ? String(versionIds[0]) : "";

    setSelectedVersionId((currentSelectedVersionId) => {
      if (!nextVersionId) {
        return "";
      }

      return currentSelectedVersionId === nextVersionId
        ? currentSelectedVersionId
        : nextVersionId;
    });
  }, [selectedCatalog]);

  // Products listing removed from UI; product list refresh logic omitted.

  useEffect(() => {
    let cancelled = false;
    let timeoutId = null;

    const checkFullDetailsCache = async () => {
      if (!selectedVersionId) {
        setFullDetailsCacheAvailable(false);
        setFullDetailsCacheStatus("missing");
        setFullDetailsReady(false);
        return;
      }

      try {
        const { data } = await fetchApi(
          `/api/catalog-products/full-details/status?catalogVersionId=${encodeURIComponent(selectedVersionId)}&lang=en-US`,
          {},
          "Failed to check full details cache status.",
        );

        if (cancelled) {
          return;
        }

        const hasCache = Boolean(data.hasCache);
        setFullDetailsCacheAvailable(hasCache);
        setFullDetailsCacheStatus(
          data.status || (hasCache ? "ready" : "missing"),
        );
        setFullDetailsReady(hasCache);
        setFullDetailsMetadata(data.metadata || null);

        if (!hasCache) {
          setFullProductDetails([]);
        }

        if (data.status === "running") {
          timeoutId = window.setTimeout(
            checkFullDetailsCache,
            FULL_DETAILS_POLL_INTERVAL_MS,
          );
        }
      } catch (_error) {
        if (cancelled) {
          return;
        }

        setFullDetailsCacheAvailable(false);
        setFullDetailsCacheStatus("missing");
        setFullDetailsReady(false);
      }
    };

    checkFullDetailsCache();

    return () => {
      cancelled = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [selectedVersionId]);

  useEffect(() => {
    if (
      !selectedVersionId ||
      (fullDetailsCacheStatus !== "running" && !fullDetailsLoading)
    ) {
      return undefined;
    }

    let cancelled = false;

    const pollRunningStatus = async () => {
      try {
        const { data } = await fetchApi(
          `/api/catalog-products/full-details/status?catalogVersionId=${encodeURIComponent(selectedVersionId)}&lang=en-US`,
          {},
          "Failed to check full details cache status.",
        );

        if (cancelled) {
          return;
        }

        const hasCache = Boolean(data.hasCache);
        setFullDetailsCacheAvailable(hasCache);
        setFullDetailsCacheStatus(
          data.status || (hasCache ? "ready" : "missing"),
        );
        setFullDetailsReady(hasCache);
        setFullDetailsMetadata(data.metadata || null);
      } catch (_error) {
        // Keep the current visible progress if a single status poll fails.
      }
    };

    pollRunningStatus();
    const intervalId = window.setInterval(
      pollRunningStatus,
      FULL_DETAILS_POLL_INTERVAL_MS,
    );

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [selectedVersionId, fullDetailsCacheStatus, fullDetailsLoading]);

  const _loadFullProductDetails = async (
    force = false,
    versionId = selectedVersionId,
    restartedFromBlank = false,
  ) => {
    if (!versionId) {
      return;
    }

    try {
      setFullDetailsLoading(true);
      setFullDetailsError("");
      setShowFullDetails(true);
      setFullDetailsReady(false);

      const { response, data } = await fetchApi(
        `/api/catalog-products/full-details?catalogVersionId=${encodeURIComponent(versionId)}&lang=en-US&force=${force}`,
        {},
        "Product full details API returned an invalid response.",
      );

      if (isBlankPayload(data)) {
        if (restartedFromBlank) {
          throw new Error(
            "Product full details API returned a blank response after restart.",
          );
        }

        setFullProductDetails([]);
        setFullDetailsMetadata({
          catalogVersionId: versionId,
          lang: "en-US",
          status: "running",
          completed: 0,
          total: 0,
          progressPercent: 0,
          currentStep: "Restarting full-details refresh from first product.",
        });
        setFullDetailsCacheAvailable(false);
        setFullDetailsCacheStatus("running");
        setFullDetailsReady(false);
        await _loadFullProductDetails(true, versionId, true);
        return;
      }

      if (response.status === 202 || data.status === "running") {
        setFullProductDetails(Array.isArray(data.preview) ? data.preview : []);
        setFullDetailsMetadata(data.metadata || null);
        setFullDetailsCacheAvailable(false);
        setFullDetailsCacheStatus(data.metadata?.status || "running");
        setFullDetailsError("");
        setFullDetailsReady(false);

        for (;;) {
          await new Promise((resolve) =>
            window.setTimeout(resolve, FULL_DETAILS_POLL_INTERVAL_MS),
          );

          const { data: statusData } = await fetchApi(
            `/api/catalog-products/full-details/status?catalogVersionId=${encodeURIComponent(versionId)}&lang=en-US`,
            {},
            "Failed to check full details cache status.",
          );

          if (isBlankPayload(statusData)) {
            if (restartedFromBlank) {
              throw new Error(
                "Full details status API returned a blank response after restart.",
              );
            }

            setFullProductDetails([]);
            setFullDetailsMetadata({
              catalogVersionId: versionId,
              lang: "en-US",
              status: "running",
              completed: 0,
              total: 0,
              progressPercent: 0,
              currentStep:
                "Restarting full-details refresh from first product.",
            });
            setFullDetailsCacheAvailable(false);
            setFullDetailsCacheStatus("running");
            setFullDetailsReady(false);
            await _loadFullProductDetails(true, versionId, true);
            return;
          }

          setFullDetailsMetadata(statusData.metadata || null);
          setFullDetailsCacheStatus(
            statusData.status || (statusData.hasCache ? "ready" : "missing"),
          );
          setFullDetailsError("");

          if (statusData.status === "failed") {
            throw new Error(
              statusData.metadata?.error ||
                "Full details cache generation failed.",
            );
          }

          if (statusData.status !== "running") {
            break;
          }
        }

        const { data: readyData } = await fetchApi(
          `/api/catalog-products/full-details?catalogVersionId=${encodeURIComponent(versionId)}&lang=en-US&force=false`,
          {},
          "Product full details API returned an invalid response.",
        );

        setFullProductDetails(
          Array.isArray(readyData.preview) ? readyData.preview : [],
        );
        setFullDetailsMetadata(readyData.metadata || null);
        setFullDetailsCacheAvailable(true);
        setFullDetailsCacheStatus("ready");
        setFullDetailsError("");
        setFullDetailsReady(true);
        await loadGeneratedFiles();
        return;
      }

      setFullProductDetails(Array.isArray(data.preview) ? data.preview : []);
      setFullDetailsMetadata(data.metadata || null);
      setFullDetailsCacheAvailable(true);
      setFullDetailsCacheStatus("ready");
      setFullDetailsError("");
      setFullDetailsReady(true);
      await loadGeneratedFiles();
    } catch (err) {
      setFullProductDetails([]);
      setFullDetailsMetadata(null);
      setFullDetailsCacheAvailable(false);
      setFullDetailsCacheStatus("missing");
      setFullDetailsReady(false);
      setFullDetailsError(
        err.message || "Unexpected error while loading product full details.",
      );
    } finally {
      setFullDetailsLoading(false);
    }
  };

  const handleRefresh = useCallback(() => {
    loadCatalogs(true);
  }, []);

  const isDailyRefreshRunning =
    dailyRefreshLoading ||
    dailyRefreshManualRunActive ||
    Boolean(dailyRefreshStatus?.running);

  const handleRunDailyRefresh = useCallback(async () => {
    if (isDailyRefreshRunning) {
      return;
    }

    const confirmed = window.confirm(
      "Run daily refresh now? This will refresh products, refresh full details, and regenerate product JSON files.",
    );
    if (!confirmed) {
      return;
    }

    try {
      setDailyRefreshLoading(true);
      setDailyRefreshManualRunActive(true);
      setDailyRefreshError("");
      const startedAt = new Date().toISOString();
      setDailyRefreshStatus((currentStatus) => ({
        ...(currentStatus || {}),
        running: true,
        currentRun: {
          status: "running",
          reason: "manual",
          startedAt,
          lang: "en-US",
          catalogVersionIds: Array.isArray(currentStatus?.catalogVersionIds)
            ? currentStatus.catalogVersionIds
            : [],
        },
      }));

      await fetchApi(
        "/api/daily-refresh/run",
        {
          method: "POST",
          headers: DEFAULT_HEADERS,
          body: JSON.stringify({}),
        },
        "Failed to run daily refresh.",
      );

      window.setTimeout(loadDailyRefreshStatus, 500);
    } catch (error) {
      setDailyRefreshError(error.message || "Unable to run daily refresh.");
      await loadDailyRefreshStatus();
    } finally {
      setDailyRefreshLoading(false);
    }
  }, [isDailyRefreshRunning, loadDailyRefreshStatus]);

  const handleDailyRefreshCatalogToggle = useCallback((catalogId) => {
    const normalizedId = String(catalogId || "");
    setSelectedDailyRefreshCatalogIds((currentIds) =>
      currentIds.includes(normalizedId)
        ? currentIds.filter((id) => id !== normalizedId)
        : [...currentIds, normalizedId],
    );
    setDailyRefreshSelectionOptions((current) => ({
      ...current,
      [normalizedId]: current[normalizedId] || {
        versionStrategy: "LATEST",
        catalogVersionId: "",
      },
    }));
  }, []);

  const handleDailyRefreshVersionOptionChange = useCallback(
    (catalogId, field, value) => {
      setDailyRefreshSelectionOptions((current) => ({
        ...current,
        [String(catalogId)]: {
          ...(current[String(catalogId)] || {}),
          [field]: value,
        },
      }));
    },
    [],
  );

  const handleSelectAllDailyRefreshCatalogs = useCallback(() => {
    setSelectedDailyRefreshCatalogIds(
      catalogs
        .filter((catalog) => getCatalogVersionIds(catalog).length > 0)
        .map((catalog) => String(catalog.id)),
    );
  }, [catalogs]);

  const handleClearDailyRefreshCatalogs = useCallback(() => {
    setSelectedDailyRefreshCatalogIds([]);
  }, []);

  const handleSaveDailyRefreshSelection = useCallback(async () => {
    try {
      setDailyRefreshSelectionSaving(true);
      setDailyRefreshError("");
      const { data } = await fetchApi(
        "/api/daily-refresh/selection",
        {
          method: "POST",
          headers: DEFAULT_HEADERS,
          body: JSON.stringify({
            lang: "en-US",
            selectedCatalogIds: selectedDailyRefreshCatalogIds,
            selections: selectedDailyRefreshCatalogIds.map((catalogId) => {
              const catalog = catalogs.find(
                (item) => String(item.id) === String(catalogId),
              );
              const option =
                dailyRefreshSelectionOptions[String(catalogId)] || {};
              return {
                catalogId: String(catalogId),
                catalogName: catalog?.name || catalog?.title || "",
                siteCode: catalog?.code || "",
                versionStrategy:
                  option.versionStrategy === "PINNED" ? "PINNED" : "LATEST",
                catalogVersionId:
                  option.versionStrategy === "PINNED"
                    ? String(
                        option.catalogVersionId ||
                          getCatalogVersionIds(catalog)[0] ||
                          "",
                      )
                    : null,
              };
            }),
          }),
        },
        "Failed to save daily refresh selection.",
      );
      if (Array.isArray(data?.selectedCatalogIds)) {
        setSelectedDailyRefreshCatalogIds(data.selectedCatalogIds.map(String));
      }
      setDailyRefreshSelectionSavedAt(data?.updatedAt || "");
      await loadDailyRefreshStatus();
    } catch (error) {
      setDailyRefreshError(
        error.message || "Unable to save daily refresh selection.",
      );
    } finally {
      setDailyRefreshSelectionSaving(false);
    }
  }, [
    catalogs,
    dailyRefreshSelectionOptions,
    loadDailyRefreshStatus,
    selectedDailyRefreshCatalogIds,
  ]);

  // Product list refresh and site-cache clearing handlers removed with Products UI.

  // const handleViewFullDetails = () => {
  //   loadFullProductDetails(false);
  // };

  // const handleRefreshFullDetails = () => {
  //   if (isFullDetailsRunning) {
  //     return;
  //   }

  //   const latestVersionId = selectedCatalogVersionIds[0]
  //     ? String(selectedCatalogVersionIds[0])
  //     : selectedVersionId;

  //   if (latestVersionId && latestVersionId !== selectedVersionId) {
  //     setSelectedVersionId(latestVersionId);
  //   }

  //   loadFullProductDetails(true, latestVersionId);
  // };

  // const handleGenerateProductJsonFiles = useCallback(async () => {
  //   if (!selectedVersionId || !fullDetailsReady) {
  //     return;
  //   }

  //   try {
  //     setProductJsonExportLoading(true);
  //     setProductJsonExportError("");

  //     let data = null;

  //     for (;;) {
  //       const result = await fetchApi(
  //         "/api/catalog-products/export-by-type",
  //         {
  //           method: "POST",
  //           headers: DEFAULT_HEADERS,
  //           body: JSON.stringify({
  //             catalogVersionId: selectedVersionId,
  //             lang: "en-US",
  //           }),
  //         },
  //         "Failed to generate product JSON files.",
  //       );

  //       data = result.data;
  //       setProductJsonExportResult(data || null);

  //       if (result.response.status !== 202 && data?.status !== "running") {
  //         break;
  //       }

  //       await new Promise((resolve) =>
  //         window.setTimeout(resolve, FULL_DETAILS_POLL_INTERVAL_MS),
  //       );
  //     }

  //     setProductJsonExportResult(data || null);
  //     await loadGeneratedFiles();
  //   } catch (error) {
  //     const message = error.message || "Unable to generate product JSON files.";
  //     setProductJsonExportResult(null);
  //     setProductJsonExportError(
  //       message === "Failed to fetch"
  //         ? "Unable to reach the backend export route. Restart the server so it picks up /api/catalog-products/export-by-type, then try again."
  //         : message,
  //     );
  //   } finally {
  //     setProductJsonExportLoading(false);
  //   }
  // }, [selectedVersionId, fullDetailsReady, loadGeneratedFiles]);

  const handleSearchChange = useCallback((event) => {
    setSearchTerm(event.target.value);
  }, []);

  const handleDailyRefreshSearchChange = useCallback((event) => {
    setDailyRefreshSearchTerm(event.target.value);
  }, []);

  const handleCatalogClick = useCallback((catalog) => {
    setSelectedCatalog(catalog);
  }, []);

  const handleVersionChange = useCallback((event) => {
    setSelectedVersionId(event.target.value);
    setFullProductDetails([]);
    setFullDetailsMetadata(null);
    setFullDetailsError("");
    setFullDetailsReady(false);
    setFullDetailsCacheAvailable(false);
    setFullDetailsCacheStatus("missing");
    setGeneratedFiles(null);
    setGeneratedFilesError("");
  }, []);

  const handleCopyText = useCallback(async (value, label) => {
    try {
      await navigator.clipboard.writeText(value);
      window.alert(`${label} copied.`);
    } catch (_error) {
      window.alert(`Unable to copy ${label.toLowerCase()}.`);
    }
  }, []);

  const handleTextareaClick = useCallback((event) => {
    event.currentTarget.focus();
  }, []);

  // OPTIMIZATION: Memoize expensive computations
  const selectedCatalogVersionIds = useMemo(
    () => (selectedCatalog ? getCatalogVersionIds(selectedCatalog) : []),
    [selectedCatalog],
  );

  const handleRunSelectedSiteDailyRefresh = useCallback(async () => {
    if (isDailyRefreshRunning || !selectedCatalogVersionIds.length) {
      return;
    }

    const latestVersionId = selectedCatalogVersionIds[0]
      ? String(selectedCatalogVersionIds[0])
      : "";
    if (!latestVersionId) {
      return;
    }

    const confirmed = window.confirm(
      `Run daily refresh now for ${selectedCatalog?.name || "this site"} using latest version ${latestVersionId}?`,
    );
    if (!confirmed) {
      return;
    }

    try {
      setDailyRefreshLoading(true);
      setDailyRefreshManualRunActive(true);
      setDailyRefreshError("");
      setDailyRefreshStatus((currentStatus) => ({
        ...(currentStatus || {}),
        running: true,
        currentRun: {
          status: "running",
          reason: "manual",
          startedAt: new Date().toISOString(),
          lang: "en-US",
          catalogVersionIds: [latestVersionId],
        },
      }));

      await fetchApi(
        "/api/daily-refresh/run",
        {
          method: "POST",
          headers: DEFAULT_HEADERS,
          body: JSON.stringify({
            catalogVersionIds: [latestVersionId],
            lang: "en-US",
            spacingMinutes: 0,
          }),
        },
        "Failed to run daily refresh for this site.",
      );

      window.setTimeout(loadDailyRefreshStatus, 500);
    } catch (error) {
      setDailyRefreshError(
        error.message || "Unable to run daily refresh for this site.",
      );
      await loadDailyRefreshStatus();
    } finally {
      setDailyRefreshLoading(false);
    }
  }, [
    isDailyRefreshRunning,
    loadDailyRefreshStatus,
    selectedCatalog,
    selectedCatalogVersionIds,
  ]);

  const selectedCatalogJson = useMemo(
    () => (selectedCatalog ? JSON.stringify(selectedCatalog, null, 2) : ""),
    [selectedCatalog],
  );

  // productsJson removed — Products UI was removed

  const firstFullProductDetails = useMemo(
    () => fullProductDetails[0] || null,
    [fullProductDetails],
  );

  const fullProductDetailsJson = useMemo(
    () =>
      firstFullProductDetails
        ? JSON.stringify(firstFullProductDetails, null, 2)
        : "",
    [firstFullProductDetails],
  );

  const _canViewFullDetails =
    fullDetailsCacheAvailable || fullDetailsCacheStatus === "ready";
  const _isFullDetailsRunning =
    fullDetailsMetadata?.status === "running" ||
    fullDetailsCacheStatus === "running";

  const fullDetailsLogs = useMemo(
    () =>
      Array.isArray(fullDetailsMetadata?.logs) ? fullDetailsMetadata.logs : [],
    [fullDetailsMetadata?.logs],
  );

  const _fullDetailsLogsText = useMemo(
    () =>
      fullDetailsLogs
        .map((entry) => {
          const timestamp = entry?.timestamp || "";
          const message = entry?.message || "";
          const details = entry?.details
            ? ` ${JSON.stringify(entry.details)}`
            : "";
          return `${timestamp} ${message}${details}`.trim();
        })
        .join("\n"),
    [fullDetailsLogs],
  );

  const productJsonExportFiles = useMemo(
    () =>
      Array.isArray(productJsonExportResult?.files)
        ? productJsonExportResult.files.filter(
            (file) =>
              file?.productType !== "unknown" &&
              file?.fileName !== "unknown.json",
          )
        : [],
    [productJsonExportResult?.files],
  );

  const generatedProductTypeFiles = useMemo(
    () =>
      Array.isArray(generatedFiles?.productTypeFiles)
        ? generatedFiles.productTypeFiles.filter(
            (file) =>
              file?.productType !== "unknown" &&
              file?.fileName !== "unknown.json",
          )
        : [],
    [generatedFiles?.productTypeFiles],
  );

  const dailyRefreshStatusText = useMemo(() => {
    if (!dailyRefreshStatus) {
      return "";
    }

    const state = dailyRefreshStatus.running
      ? "Running"
      : dailyRefreshStatus.enabled
        ? "Enabled"
        : "Disabled";
    const nextRun = dailyRefreshStatus.nextRunAt
      ? new Date(dailyRefreshStatus.nextRunAt).toLocaleString()
      : "not scheduled";
    const catalogVersionIds = Array.isArray(
      dailyRefreshStatus.catalogVersionIds,
    )
      ? dailyRefreshStatus.catalogVersionIds.join(", ")
      : "";

    return `Daily refresh: ${state} | Next run: ${nextRun}${
      catalogVersionIds ? ` | Catalog versions: ${catalogVersionIds}` : ""
    }`;
  }, [dailyRefreshStatus]);

  const dailyRefreshDurationText = useMemo(() => {
    if (!dailyRefreshStatus) {
      return "";
    }

    const currentRun = dailyRefreshStatus.currentRun;
    if (
      (dailyRefreshStatus.running && currentRun?.startedAt) ||
      (dailyRefreshManualRunActive && !dailyRefreshStatus.lastRun?.completedAt)
    ) {
      const startedAt = currentRun?.startedAt;
      const startedMs = startedAt ? new Date(startedAt).getTime() : null;
      const elapsedMs = Number.isFinite(startedMs)
        ? dailyRefreshTick - startedMs
        : currentRun?.elapsedMs;
      const catalogVersionIds = Array.isArray(currentRun?.catalogVersionIds)
        ? currentRun.catalogVersionIds.join(", ")
        : Array.isArray(dailyRefreshStatus.catalogVersionIds)
          ? dailyRefreshStatus.catalogVersionIds.join(", ")
          : "";

      return `Run time: ${formatDuration(elapsedMs || 0)} elapsed${
        catalogVersionIds ? ` for catalog version ${catalogVersionIds}` : ""
      }`;
    }

    const lastRun = dailyRefreshStatus.lastRun;
    if (!lastRun?.startedAt || !lastRun?.completedAt) {
      return "";
    }

    const durationMs =
      typeof lastRun.durationMs === "number"
        ? lastRun.durationMs
        : new Date(lastRun.completedAt).getTime() -
          new Date(lastRun.startedAt).getTime();
    const completedAt = new Date(lastRun.completedAt).toLocaleString();
    const catalogVersionIds = Array.isArray(lastRun.catalogVersionIds)
      ? lastRun.catalogVersionIds.join(", ")
      : "";

    return `Last run ${lastRun.status || "completed"} in ${formatDuration(
      durationMs,
    )}${catalogVersionIds ? ` for catalog version ${catalogVersionIds}` : ""} | Completed: ${completedAt}`;
  }, [dailyRefreshManualRunActive, dailyRefreshStatus, dailyRefreshTick]);

  const selectedDailyRefreshCatalogIdSet = useMemo(
    () => new Set(selectedDailyRefreshCatalogIds.map(String)),
    [selectedDailyRefreshCatalogIds],
  );

  const savedDailyRefreshSelectionKey = useMemo(
    () =>
      (dailyRefreshStatus?.availableCatalogs || [])
        .filter((catalog) => catalog.selected)
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
        .map((catalog) => {
          const strategy =
            catalog.versionStrategy === "PINNED" ? "PINNED" : "LATEST";
          const versionId =
            strategy === "PINNED" ? catalog.selectedVersionId || "" : "";
          return `${catalog.id}:${strategy}:${versionId}`;
        })
        .join("|"),
    [dailyRefreshStatus?.availableCatalogs],
  );

  const currentDailyRefreshSelectionKey = useMemo(
    () =>
      selectedDailyRefreshCatalogIds
        .map(String)
        .sort()
        .map((id) => {
          const option = dailyRefreshSelectionOptions[id] || {};
          const strategy =
            option.versionStrategy === "PINNED" ? "PINNED" : "LATEST";
          const versionId =
            strategy === "PINNED" ? option.catalogVersionId || "" : "";
          return `${id}:${strategy}:${versionId}`;
        })
        .join("|"),
    [dailyRefreshSelectionOptions, selectedDailyRefreshCatalogIds],
  );

  const dailyRefreshSelectionDirty =
    currentDailyRefreshSelectionKey !== savedDailyRefreshSelectionKey;

  const dailyRefreshSelectionStatusText = useMemo(() => {
    if (dailyRefreshSelectionSaving) {
      return "Saving selected catalogs for daily cron...";
    }

    if (dailyRefreshSelectionDirty) {
      return "Unsaved changes: click Save Cron Selection so the daily cron uses this catalog list.";
    }

    if (dailyRefreshSelectionSavedAt) {
      return `Saved for daily cron: ${new Date(dailyRefreshSelectionSavedAt).toLocaleString()}`;
    }

    return "No saved catalog selection yet. Save a selection so the daily cron can use it.";
  }, [
    dailyRefreshSelectionDirty,
    dailyRefreshSelectionSavedAt,
    dailyRefreshSelectionSaving,
  ]);

  const dailyRefreshCatalogRows = useMemo(
    () =>
      catalogs.map((catalog) => {
        const latestVersionId = getCatalogVersionIds(catalog)[0] || "";
        const versionIds = getCatalogVersionIds(catalog).map(String);
        const option =
          dailyRefreshSelectionOptions[String(catalog.id || "")] || {};

        return {
          id: String(catalog.id || ""),
          name: catalog.name || catalog.title || "Unnamed catalog",
          code: catalog.code || "",
          latestVersionId: latestVersionId ? String(latestVersionId) : "",
          versionIds,
          versionStrategy: option.versionStrategy || "LATEST",
          selectedVersionId:
            option.catalogVersionId || String(latestVersionId || ""),
          versionCount: getVersionCount(catalog),
          selected: selectedDailyRefreshCatalogIdSet.has(
            String(catalog.id || ""),
          ),
        };
      }),
    [catalogs, dailyRefreshSelectionOptions, selectedDailyRefreshCatalogIdSet],
  );

  const filteredDailyRefreshCatalogRows = useMemo(() => {
    const searchValue = dailyRefreshSearchTerm.trim().toLowerCase();
    return dailyRefreshCatalogRows.filter((catalog) => {
      if (dailyRefreshCatalogFilter === "selected" && !catalog.selected) {
        return false;
      }
      if (!searchValue) {
        return true;
      }
      const searchableText = [
        catalog.id,
        catalog.name,
        catalog.code,
        catalog.latestVersionId,
      ]
        .join(" ")
        .toLowerCase();

      return searchableText.includes(searchValue);
    });
  }, [
    dailyRefreshCatalogFilter,
    dailyRefreshCatalogRows,
    dailyRefreshSearchTerm,
  ]);

  const selectedDailyRefreshLatestVersionIds = useMemo(
    () =>
      dailyRefreshCatalogRows
        .filter((catalog) => catalog.selected && catalog.latestVersionId)
        .map((catalog) =>
          catalog.versionStrategy === "PINNED"
            ? catalog.selectedVersionId
            : catalog.latestVersionId,
        ),
    [dailyRefreshCatalogRows],
  );

  const handleRunDailyRefreshSelection = useCallback(async () => {
    if (isDailyRefreshRunning) {
      return;
    }

    const confirmed = window.confirm(
      "Run daily refresh now for the selected catalogs? Each catalog will use its latest version ID.",
    );
    if (!confirmed) {
      return;
    }

    try {
      setDailyRefreshLoading(true);
      setDailyRefreshManualRunActive(true);
      setDailyRefreshError("");
      const startedAt = new Date().toISOString();
      setDailyRefreshStatus((currentStatus) => ({
        ...(currentStatus || {}),
        running: true,
        currentRun: {
          status: "running",
          reason: "manual",
          startedAt,
          lang: "en-US",
          catalogVersionIds: selectedDailyRefreshLatestVersionIds,
        },
      }));

      await fetchApi(
        "/api/daily-refresh/run",
        {
          method: "POST",
          headers: DEFAULT_HEADERS,
          body: JSON.stringify({
            lang: "en-US",
            catalogVersionIds: selectedDailyRefreshLatestVersionIds,
          }),
        },
        "Failed to run daily refresh.",
      );

      window.setTimeout(loadDailyRefreshStatus, 500);
    } catch (error) {
      setDailyRefreshError(error.message || "Unable to run daily refresh.");
      await loadDailyRefreshStatus();
    } finally {
      setDailyRefreshLoading(false);
    }
  }, [
    isDailyRefreshRunning,
    loadDailyRefreshStatus,
    selectedDailyRefreshLatestVersionIds,
  ]);

  if (authLoading || !isAuthenticated) {
    return (
      <AuthScreen
        loading={authLoading}
        mode={authMode}
        username={loginUsername}
        password={loginPassword}
        passwordConfirmation={signupPasswordConfirmation}
        error={authError}
        submitting={loginSubmitting}
        onUsernameChange={setLoginUsername}
        onPasswordChange={setLoginPassword}
        onPasswordConfirmationChange={setSignupPasswordConfirmation}
        onSignIn={handleLoginSubmit}
        onSignUp={handleSignupSubmit}
        onModeChange={(mode) => {
          setAuthMode(mode);
          setAuthError("");
          setLoginPassword("");
          setSignupPasswordConfirmation("");
        }}
      />
    );
  }

  return (
    <main className="app">
      <ConsoleHeader
        user={user}
        loading={loading}
        error={error}
        metadata={metadata}
        activePage={activePage}
        catalogCount={catalogs.length}
        activeCount={activeCount}
        inactiveCount={inactiveCount}
        selectedVersionId={selectedVersionId}
        selectedRefreshCount={selectedDailyRefreshLatestVersionIds.length}
        refreshRunning={isDailyRefreshRunning}
        refreshDurationText={dailyRefreshDurationText}
        refreshStatusText={dailyRefreshStatusText}
        refreshError={dailyRefreshError}
        onLogout={handleLogout}
        onRefreshCatalogs={handleRefresh}
        onRunRefresh={handleRunDailyRefresh}
        onPageChange={setActivePage}
      />

      {!loading && !error && activePage === "daily-refresh" && (
        <section className="details-panel daily-refresh-page">
          <div className="details-heading">
            <div>
              <p className="eyebrow">Daily refresh participation</p>
              <h2>Selected Catalogs</h2>
            </div>
            <span className="catalog-code-pill">
              {selectedDailyRefreshLatestVersionIds.length} latest versions
            </span>
          </div>
          <div className="daily-refresh-actions">
            <button
              type="button"
              className="refresh-btn"
              onClick={handleSaveDailyRefreshSelection}
              disabled={dailyRefreshSelectionSaving}>
              {dailyRefreshSelectionSaving
                ? "Saving..."
                : "Save Cron Selection"}
            </button>
            <button
              type="button"
              className="refresh-btn secondary-action"
              onClick={handleRunDailyRefreshSelection}
              disabled={
                isDailyRefreshRunning ||
                !selectedDailyRefreshLatestVersionIds.length
              }>
              {isDailyRefreshRunning
                ? "Daily Refresh Running..."
                : "Run Daily Refresh Now"}
            </button>
            <button
              type="button"
              className="copy-btn"
              onClick={handleSelectAllDailyRefreshCatalogs}>
              Select All Active
            </button>
            <button
              type="button"
              className="copy-btn"
              onClick={handleClearDailyRefreshCatalogs}>
              Clear
            </button>
          </div>
          <p
            className={`status ${
              dailyRefreshSelectionDirty ? "warning-status" : ""
            }`}>
            {dailyRefreshSelectionStatusText}
          </p>
          <p className="status">
            Selected latest version IDs:{" "}
            {selectedDailyRefreshLatestVersionIds.length
              ? selectedDailyRefreshLatestVersionIds.join(", ")
              : "-"}
            {" | "}Spacing: {dailyRefreshStatus?.spacingMinutes ?? 3} minutes
          </p>
          <div className="daily-refresh-search-row">
            <input
              type="text"
              value={dailyRefreshSearchTerm}
              onChange={handleDailyRefreshSearchChange}
              className="search-input"
              placeholder="Search by catalog name, ID, site code, or latest version"
            />
            <div
              className="filter-group"
              aria-label="Daily refresh catalog filter">
              <button
                type="button"
                className={`filter-btn ${dailyRefreshCatalogFilter === "all" ? "active-filter" : ""}`}
                onClick={() => setDailyRefreshCatalogFilter("all")}>
                All ({dailyRefreshCatalogRows.length})
              </button>
              <button
                type="button"
                className={`filter-btn ${dailyRefreshCatalogFilter === "selected" ? "active-filter" : ""}`}
                onClick={() => setDailyRefreshCatalogFilter("selected")}>
                Selected ({selectedDailyRefreshCatalogIds.length})
              </button>
            </div>
          </div>
          <p className="status">
            Showing {filteredDailyRefreshCatalogRows.length} of{" "}
            {dailyRefreshCatalogRows.length} catalogs
          </p>
          <div className="daily-refresh-catalog-list" role="list">
            {filteredDailyRefreshCatalogRows.map((catalog) => (
              <label
                key={catalog.id}
                className={`daily-refresh-catalog-row ${
                  catalog.selected ? "selected-item" : ""
                }`}>
                <input
                  type="checkbox"
                  checked={catalog.selected}
                  disabled={!catalog.latestVersionId}
                  onChange={() => handleDailyRefreshCatalogToggle(catalog.id)}
                />
                <span className="daily-refresh-catalog-body">
                  <strong>{catalog.name}</strong>
                  <span>ID: {catalog.id}</span>
                  <span>Site code: {catalog.code || "-"}</span>
                  <span>
                    Latest version: {catalog.latestVersionId || "-"} | Versions:{" "}
                    {catalog.versionCount}
                  </span>
                  {catalog.selected && (
                    <span className="version-panel">
                      <select
                        aria-label={`Version strategy for ${catalog.name}`}
                        value={catalog.versionStrategy}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          handleDailyRefreshVersionOptionChange(
                            catalog.id,
                            "versionStrategy",
                            event.target.value,
                          )
                        }>
                        <option value="LATEST">Always use latest</option>
                        <option value="PINNED">Pin a version</option>
                      </select>
                      {catalog.versionStrategy === "PINNED" && (
                        <select
                          aria-label={`Pinned version for ${catalog.name}`}
                          value={catalog.selectedVersionId}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            handleDailyRefreshVersionOptionChange(
                              catalog.id,
                              "catalogVersionId",
                              event.target.value,
                            )
                          }>
                          {catalog.versionIds.map((versionId) => (
                            <option key={versionId} value={versionId}>
                              {versionId}
                            </option>
                          ))}
                        </select>
                      )}
                    </span>
                  )}
                </span>
              </label>
            ))}
            {!filteredDailyRefreshCatalogRows.length && (
              <p className="empty-state">
                No daily refresh catalogs match the current search.
              </p>
            )}
          </div>
        </section>
      )}

      {!loading && !error && activePage === "catalogs" && (
        <CatalogList
          catalogs={catalogs}
          filteredCatalogs={filteredCatalogs}
          selectedCatalogId={selectedCatalog?.id}
          searchTerm={searchTerm}
          activeFilter={activeFilter}
          activeCount={activeCount}
          inactiveCount={inactiveCount}
          onSearchChange={handleSearchChange}
          onFilterChange={setActiveFilter}
          onSelectCatalog={handleCatalogClick}
          getVersionCount={getVersionCount}
          getVersionIds={getVersionIds}
          isCatalogActive={isCatalogActive}>
          <CatalogViewer
            catalog={selectedCatalog}
            catalogJson={selectedCatalogJson}
            versionIds={selectedCatalogVersionIds}
            selectedVersionId={selectedVersionId}
            refreshRunning={isDailyRefreshRunning}
            onCopy={handleCopyText}
            onTextareaClick={handleTextareaClick}
            onVersionChange={handleVersionChange}
            onRunRefresh={handleRunSelectedSiteDailyRefresh}
            getVersionCount={getVersionCount}
            isCatalogActive={isCatalogActive}>
            <h3>Product Full Details</h3>
            <div className="section-toolbar">
              <span className="resize-hint">
                Drag bottom-right corner to resize
              </span>
              {/* <div className="action-group">
                      <button
                        type="button"
                        className="copy-btn"
                        onClick={handleViewFullDetails}
                        disabled={
                          !selectedVersionId ||
                          fullDetailsLoading ||
                          !canViewFullDetails
                        }>
                        {fullDetailsLoading
                          ? "Loading Full Details..."
                          : "View Product Full Details"}
                      </button>
                      <button
                        type="button"
                        className="copy-btn"
                        onClick={handleRefreshFullDetails}
                        disabled={
                          !selectedVersionId ||
                          fullDetailsLoading ||
                          isFullDetailsRunning
                        }>
                        {isFullDetailsRunning
                          ? "Refreshing Full Details..."
                          : "Refresh Full Details"}
                      </button>
                      <button
                        type="button"
                        className="copy-btn"
                        onClick={handleGenerateProductJsonFiles}
                        disabled={
                          !fullDetailsReady || productJsonExportLoading
                        }>
                        {productJsonExportLoading
                          ? "Generating Product JSON..."
                          : "Generate Product JSON Files"}
                      </button>
                    </div> */}
            </div>
            {fullDetailsMetadata &&
              !fullDetailsLoading &&
              !fullDetailsError && (
                <p className="status">
                  Full Details: {fullDetailsMetadata.fullDetailsTotal} |
                  Products:{" "}
                  {fullDetailsMetadata.productsTotal ??
                    fullDetailsMetadata.total ??
                    0}{" "}
                  | Showing First: {fullDetailsMetadata.previewCount} | Source:{" "}
                  {fullDetailsMetadata.source}
                  {fullDetailsMetadata.updatedAt
                    ? ` | Updated: ${new Date(fullDetailsMetadata.updatedAt).toLocaleString()}`
                    : ""}
                </p>
              )}
            {fullDetailsError && (
              <p className="status error">{fullDetailsError}</p>
            )}
            {productJsonExportError && (
              <p className="status error">{productJsonExportError}</p>
            )}
            {fullDetailsMetadata?.status === "running" && (
              <div className="progress-panel" aria-live="polite">
                {fullDetailsMetadata.currentStep && (
                  <p className="status">{fullDetailsMetadata.currentStep}</p>
                )}
                <div className="progress-row">
                  <span>Full details</span>
                  <strong>
                    {typeof fullDetailsMetadata.completed === "number" &&
                    typeof fullDetailsMetadata.total === "number"
                      ? `${fullDetailsMetadata.completed}/${fullDetailsMetadata.total}`
                      : "-"}
                    {typeof fullDetailsMetadata.progressPercent === "number"
                      ? ` (${fullDetailsMetadata.progressPercent}%)`
                      : ""}
                  </strong>
                </div>
                <progress
                  className="progress-bar"
                  max="100"
                  value={fullDetailsMetadata.progressPercent || 0}
                />
                {fullDetailsMetadata.itemDetails && (
                  <p className="status">
                    Item API fetched:{" "}
                    {fullDetailsMetadata.itemDetails.fetched ?? 0} | Disk hits:{" "}
                    {fullDetailsMetadata.itemDetails.diskHits ?? 0} | Errors:{" "}
                    {fullDetailsMetadata.itemDetails.errors ?? 0}
                  </p>
                )}
              </div>
            )}
            {productJsonExportResult && !productJsonExportLoading && (
              <>
                <p className="status">
                  Generated {productJsonExportResult.totalFiles} files for{" "}
                  {productJsonExportResult.totalProducts} products in folder{" "}
                  {productJsonExportResult.catalogName}.
                </p>
                {!!productJsonExportFiles.length && (
                  <textarea
                    className="json-textarea"
                    value={JSON.stringify(productJsonExportFiles, null, 2)}
                    readOnly
                    tabIndex={0}
                    spellCheck={false}
                    onClick={handleTextareaClick}
                  />
                )}
              </>
            )}
            <GeneratedFilesList
              files={generatedFiles}
              productTypeFiles={generatedProductTypeFiles}
              loading={generatedFilesLoading}
              error={generatedFilesError}
              buildDownloadUrl={buildDownloadUrl}
              formatFileSize={formatFileSize}
            />
            {/* {!!fullDetailsLogs.length && (
                    <>
                      <p className="status">
                        Full details debug log ({fullDetailsLogs.length})
                      </p>
                      <textarea
                        className="json-textarea"
                        value={fullDetailsLogsText}
                        readOnly
                        tabIndex={0}
                        spellCheck={false}
                        onClick={handleTextareaClick}
                      />
                    </>
                  )} */}
            {/* {!showFullDetails && !productsLoading && !productsError && (
                    <p className="empty-state">
                      Click "View Product Full Details" to generate the cache
                      and load the first enriched product.
                    </p>
                  )} */}
            {showFullDetails &&
              !fullDetailsLoading &&
              !fullDetailsError &&
              !fullProductDetails.length && (
                <p className="empty-state">
                  No product full details available for the selected version.
                </p>
              )}
            {!!fullProductDetails.length && (
              <textarea
                className="json-textarea"
                value={fullProductDetailsJson}
                readOnly
                tabIndex={0}
                spellCheck={false}
                onClick={handleTextareaClick}
              />
            )}
          </CatalogViewer>
        </CatalogList>
      )}
    </main>
  );
}

export default App;
