import {
  Bell,
  Bold,
  CheckCircle2,
  Info,
  Italic,
  MoreHorizontal,
  Settings2,
  TriangleAlert,
  Underline,
} from "lucide-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import appIcon from "@/assets/images/icon.png";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Image } from "@/components/ui/image";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarTrigger,
} from "@/components/ui/menubar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Option } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { Toggle, ToggleIcon } from "@/components/ui/toggle";
import {
  ToggleGroup,
  ToggleGroupIcon,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const CatalogGroup = ({
  children,
  title,
}: React.PropsWithChildren<{ title: string }>) => (
  <View className="gap-3">
    <Text className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
      {title}
    </Text>
    {children}
  </View>
);

const RowLabel = ({ children }: React.PropsWithChildren) => (
  <View className="flex-row items-center gap-3">{children}</View>
);

const RnrCatalog = () => {
  const [checked, setChecked] = useState(true);
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);
  const [favoriteChecked, setFavoriteChecked] = useState(true);
  const [menubarValue, setMenubarValue] = useState<string>();
  const [outlineTogglePressed, setOutlineTogglePressed] = useState(false);
  const [radioValue, setRadioValue] = useState("balanced");
  const [selectValue, setSelectValue] = useState<Option>({
    label: "Balanced",
    value: "balanced",
  });
  const [tabValue, setTabValue] = useState("preview");
  const [toggleGroupValue, setToggleGroupValue] = useState(["bold"]);
  const [togglePressed, setTogglePressed] = useState(false);

  return (
    <View className="gap-7">
      <CatalogGroup title="Buttons and badges">
        <View className="flex-row flex-wrap gap-2">
          <Button>
            <Text>Default</Text>
          </Button>
          <Button variant="secondary">
            <Text>Secondary</Text>
          </Button>
          <Button variant="outline">
            <Text>Outline</Text>
          </Button>
          <Button variant="ghost">
            <Text>Ghost</Text>
          </Button>
          <Button variant="destructive">
            <Text>Destructive</Text>
          </Button>
          <Button disabled>
            <Text>Disabled</Text>
          </Button>
        </View>
        <View className="flex-row flex-wrap items-center gap-2">
          <Button size="sm">
            <Text>Small</Text>
          </Button>
          <Button>
            <Text>Default</Text>
          </Button>
          <Button size="lg">
            <Text>Large</Text>
          </Button>
          <Button size="icon" variant="outline">
            <ToggleIcon as={Bell} />
          </Button>
        </View>
        <View className="flex-row flex-wrap items-center gap-2">
          <Badge>
            <Text>Default</Text>
          </Badge>
          <Badge variant="secondary">
            <Text>Secondary</Text>
          </Badge>
          <Badge variant="outline">
            <Text>Outline</Text>
          </Badge>
          <Badge variant="destructive">
            <Text>Destructive</Text>
          </Badge>
        </View>
      </CatalogGroup>

      <Separator />

      <CatalogGroup title="Inputs and selection">
        <View className="gap-2">
          <Label nativeID="catalog-email">Email</Label>
          <Input
            aria-labelledby="catalog-email"
            inputMode="email"
            placeholder="you@example.com"
          />
        </View>
        <Textarea placeholder="Write a longer prompt…" />
        <RowLabel>
          <Checkbox checked={checked} onCheckedChange={setChecked} />
          <Text>Checkbox</Text>
        </RowLabel>
        <RadioGroup onValueChange={setRadioValue} value={radioValue}>
          <RowLabel>
            <RadioGroupItem value="fast" />
            <Text>Fast</Text>
          </RowLabel>
          <RowLabel>
            <RadioGroupItem value="balanced" />
            <Text>Balanced</Text>
          </RowLabel>
        </RadioGroup>
        <Select onValueChange={setSelectValue} value={selectValue}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select a mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectLabel>Response mode</SelectLabel>
            <SelectItem label="Fast" value="fast" />
            <SelectItem label="Balanced" value="balanced" />
            <SelectItem label="Thorough" value="thorough" />
          </SelectContent>
        </Select>
      </CatalogGroup>

      <Separator />

      <CatalogGroup title="Status and feedback">
        <Alert icon={Info}>
          <AlertTitle>Heads up</AlertTitle>
          <AlertDescription>
            This is the default informational alert.
          </AlertDescription>
        </Alert>
        <Alert icon={TriangleAlert} variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>Try the operation again.</AlertDescription>
        </Alert>
        <View className="gap-2">
          <Text className="text-sm font-medium">Progress</Text>
          <Progress value={64} />
        </View>
        <View className="flex-row items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <View className="flex-1 gap-2">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </View>
        </View>
      </CatalogGroup>

      <Separator />

      <CatalogGroup title="Media and surfaces">
        <View className="flex-row items-center gap-3">
          <Avatar className="size-12" alt="Expo logo">
            <AvatarImage source={appIcon} />
            <AvatarFallback>
              <Text>EX</Text>
            </AvatarFallback>
          </Avatar>
          <View className="gap-0.5">
            <Text className="font-medium">Avatar</Text>
            <Text className="text-muted-foreground text-sm">
              Image with fallback content
            </Text>
          </View>
        </View>
        <AspectRatio className="overflow-hidden rounded-xl" ratio={16 / 9}>
          <Image className="size-full" contentFit="cover" source={appIcon} />
        </AspectRatio>
        <Card>
          <CardHeader>
            <CardTitle>Card title</CardTitle>
            <CardDescription>A composed content surface.</CardDescription>
          </CardHeader>
          <CardContent>
            <Text>Card content can contain any React Native view.</Text>
          </CardContent>
          <CardFooter>
            <Button size="sm" variant="outline">
              <Text>Action</Text>
            </Button>
          </CardFooter>
        </Card>
      </CatalogGroup>

      <Separator />

      <CatalogGroup title="Disclosure and navigation">
        <Accordion collapsible defaultValue="item-1" type="single">
          <AccordionItem value="item-1">
            <AccordionTrigger>
              <Text>What is RNR?</Text>
            </AccordionTrigger>
            <AccordionContent>
              <Text>Source-owned components built on RN Primitives.</Text>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-2">
            <AccordionTrigger>
              <Text>Can it be customized?</Text>
            </AccordionTrigger>
            <AccordionContent>
              <Text>Yes. Every component lives in this repository.</Text>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        <Collapsible onOpenChange={setCollapsibleOpen} open={collapsibleOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="outline">
              <Text>{collapsibleOpen ? "Hide details" : "Show details"}</Text>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <Text className="text-muted-foreground text-sm">
              Collapsible content is now visible.
            </Text>
          </CollapsibleContent>
        </Collapsible>
        <Tabs onValueChange={setTabValue} value={tabValue}>
          <TabsList>
            <TabsTrigger value="preview">
              <Text>Preview</Text>
            </TabsTrigger>
            <TabsTrigger value="code">
              <Text>Code</Text>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="preview">
            <Text className="text-muted-foreground text-sm">
              Interactive component preview.
            </Text>
          </TabsContent>
          <TabsContent value="code">
            <Text className="font-mono text-sm">{"<Component />"}</Text>
          </TabsContent>
        </Tabs>
      </CatalogGroup>

      <Separator />

      <CatalogGroup title="Toggles">
        <View className="flex-row flex-wrap items-center gap-3">
          <Toggle onPressedChange={setTogglePressed} pressed={togglePressed}>
            <ToggleIcon as={Bold} />
            <Text>Bold</Text>
          </Toggle>
          <Toggle
            onPressedChange={setOutlineTogglePressed}
            pressed={outlineTogglePressed}
            variant="outline"
          >
            <ToggleIcon as={Settings2} />
          </Toggle>
        </View>
        <ToggleGroup
          onValueChange={setToggleGroupValue}
          type="multiple"
          value={toggleGroupValue}
          variant="outline"
        >
          <ToggleGroupItem isFirst value="bold">
            <ToggleGroupIcon as={Bold} />
          </ToggleGroupItem>
          <ToggleGroupItem value="italic">
            <ToggleGroupIcon as={Italic} />
          </ToggleGroupItem>
          <ToggleGroupItem isLast value="underline">
            <ToggleGroupIcon as={Underline} />
          </ToggleGroupItem>
        </ToggleGroup>
      </CatalogGroup>

      <Separator />

      <CatalogGroup title="Dialogs and overlays">
        <View className="flex-row flex-wrap gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">
                <Text>Dialog</Text>
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Edit prompt</DialogTitle>
                <DialogDescription>
                  Make changes and close when finished.
                </DialogDescription>
              </DialogHeader>
              <Input placeholder="Prompt title" />
              <DialogFooter>
                <DialogClose asChild>
                  <Button>
                    <Text>Done</Text>
                  </Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">
                <Text>Alert dialog</Text>
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
                <AlertDialogDescription>
                  This demonstration does not delete any data.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Text>Cancel</Text>
                </AlertDialogCancel>
                <AlertDialogAction>
                  <Text>Continue</Text>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline">
                <Text>Popover</Text>
              </Button>
            </PopoverTrigger>
            <PopoverContent>
              <Text className="font-medium">Popover content</Text>
              <Text className="text-muted-foreground mt-1 text-sm">
                Useful for compact controls and details.
              </Text>
            </PopoverContent>
          </Popover>

          <HoverCard>
            <HoverCardTrigger asChild>
              <Button variant="ghost">
                <Text>Hover card</Text>
              </Button>
            </HoverCardTrigger>
            <HoverCardContent>
              <Text className="font-medium">React Native Reusables</Text>
              <Text className="text-muted-foreground mt-1 text-sm">
                Hover on web or press on native.
              </Text>
            </HoverCardContent>
          </HoverCard>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon" variant="outline">
                <ToggleIcon as={Info} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <Text>Helpful information</Text>
            </TooltipContent>
          </Tooltip>
        </View>
      </CatalogGroup>

      <Separator />

      <CatalogGroup title="Menus">
        <View className="flex-row flex-wrap gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Text>Dropdown</Text>
                <ToggleIcon as={MoreHorizontal} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Actions</DropdownMenuLabel>
              <DropdownMenuItem>
                <Text>Duplicate</Text>
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem
                checked={favoriteChecked}
                onCheckedChange={setFavoriteChecked}
              >
                <Text>Favorite</Text>
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">
                <Text>Delete</Text>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <ContextMenu>
            <ContextMenuTrigger asChild>
              <Pressable className="border-input min-h-11 justify-center rounded-md border px-4 py-2 active:bg-accent">
                <Text className="text-sm font-medium">Long press</Text>
              </Pressable>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuLabel>Conversation</ContextMenuLabel>
              <ContextMenuItem>
                <Text>Rename</Text>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive">
                <Text>Delete</Text>
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </View>

        <Menubar onValueChange={setMenubarValue} value={menubarValue}>
          <MenubarMenu value="file">
            <MenubarTrigger>
              <Text>File</Text>
            </MenubarTrigger>
            <MenubarContent>
              <MenubarItem>
                <Text>New conversation</Text>
              </MenubarItem>
              <MenubarItem>
                <Text>Export</Text>
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem variant="destructive">
                <Text>Close</Text>
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu value="help">
            <MenubarTrigger>
              <Text>Help</Text>
            </MenubarTrigger>
            <MenubarContent>
              <MenubarItem>
                <Text>Documentation</Text>
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>
      </CatalogGroup>

      <View className="flex-row items-center gap-2 rounded-lg bg-muted p-3">
        <CheckCircle2 className="text-foreground size-4 shrink-0" />
        <Text className="min-w-0 flex-1 text-sm">
          Branded QOP primitives use RNR and Uniwind.
        </Text>
      </View>
    </View>
  );
};

export { RnrCatalog };
