import {
  Box,
  Button,
  IconButton,
  Popover,
  Stack,
  Typography,
} from "@mui/material";
import { useId, useState } from "react";

/**
 * Safe descriptor metadata is the sole source of form help. The component
 * deliberately has no access to configuration history, secret registrations,
 * or adapter details.
 */
export function DescriptorFieldHelp({
  label,
  description,
  examples = [],
  onUseExample,
}: {
  readonly label: string;
  readonly description?: string;
  readonly examples?: readonly string[];
  readonly onUseExample?: (example: string) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement>();
  const popoverId = useId();
  if (description === undefined && examples.length === 0) return null;
  const open = anchor !== undefined;
  const id = open ? popoverId : undefined;
  return (
    <Box>
      <IconButton
        aria-describedby={id}
        aria-label={`Help for ${label}`}
        onClick={(event) => setAnchor(event.currentTarget)}
        size="small"
        sx={{
          border: "1px solid",
          borderColor: "divider",
          fontSize: "0.75rem",
          height: 22,
          width: 22,
        }}
        type="button"
      >
        i
      </IconButton>
      <Popover
        anchorEl={anchor}
        anchorOrigin={{ horizontal: "left", vertical: "bottom" }}
        id={id}
        onClose={() => setAnchor(undefined)}
        open={open}
      >
        <Stack spacing={1} sx={{ maxWidth: 520, p: 2 }}>
          {description === undefined ? null : (
            <Typography variant="body2">{description}</Typography>
          )}
          {examples.length === 0 ? null : (
            <>
              <Typography variant="subtitle2">Examples</Typography>
              {examples.map((example, index) => (
                <Stack key={example} direction="row" spacing={1}>
                  <Typography
                    component="code"
                    sx={{ overflowWrap: "anywhere", flex: 1 }}
                    variant="body2"
                  >
                    {example}
                  </Typography>
                  {onUseExample === undefined ? null : (
                    <Button
                      onClick={() => {
                        onUseExample(example);
                        setAnchor(undefined);
                      }}
                      size="small"
                      type="button"
                    >
                      Use example {index + 1}
                    </Button>
                  )}
                </Stack>
              ))}
            </>
          )}
        </Stack>
      </Popover>
    </Box>
  );
}
