import { createTheme } from "@mui/material/styles";

export const operatorTheme = createTheme({
  palette: {
    mode: "dark",
    background: {
      default: "#111312",
      paper: "#171a18",
    },
    primary: {
      main: "#f0aa3c",
      contrastText: "#17120b",
    },
    secondary: {
      main: "#8ba89b",
    },
    divider: "#38403b",
    text: {
      primary: "#edf0e9",
      secondary: "#b8c0b8",
    },
    warning: {
      main: "#f0aa3c",
    },
    error: {
      main: "#ef796c",
    },
    success: {
      main: "#8bc49a",
    },
  },
  typography: {
    fontFamily:
      '"Bahnschrift", "DIN Alternate", "Segoe UI Variable", sans-serif',
    h1: {
      fontFamily: '"Iowan Old Style", "Palatino Linotype", Georgia, serif',
    },
    h2: {
      fontFamily: '"Iowan Old Style", "Palatino Linotype", Georgia, serif',
    },
    h3: {
      fontFamily: '"Iowan Old Style", "Palatino Linotype", Georgia, serif',
      fontWeight: 500,
      letterSpacing: "-0.035em",
    },
    h4: {
      fontFamily: '"Iowan Old Style", "Palatino Linotype", Georgia, serif',
    },
    h5: {
      fontFamily: '"Iowan Old Style", "Palatino Linotype", Georgia, serif',
    },
    overline: {
      color: "#f0aa3c",
      fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: "0.66rem",
      fontWeight: 700,
      letterSpacing: "0.12em",
    },
    button: {
      fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: "0.72rem",
      fontWeight: 700,
      letterSpacing: "0.05em",
    },
  },
  shape: { borderRadius: 2 },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: "#111312",
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
        },
        "::selection": { backgroundColor: "#f0aa3c", color: "#17120b" },
        "@media (prefers-reduced-motion: reduce)": {
          "*, *::before, *::after": {
            animationDuration: "0.01ms !important",
            scrollBehavior: "auto !important",
            transitionDuration: "0.01ms !important",
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 1,
          minHeight: 36,
        },
      },
    },
    MuiTextField: {
      defaultProps: {
        size: "small",
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          "&:hover": {
            backgroundColor: "rgba(240, 170, 60, 0.09)",
          },
          "&.Mui-focusVisible": {
            outline: "2px solid #f0aa3c",
            outlineOffset: "-2px",
          },
        },
      },
    },
  },
});
