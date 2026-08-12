import { View } from "react-native";

import { Screen } from "@/components/screen";
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
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { Surface } from "@/components/ui/surface";
import { Text } from "@/components/ui/text";
import { useIdentityStore } from "@/lib/identity-store";

const ProfileScreen = () => {
  const identity = useIdentityStore((state) => state.identity);
  const resetIdentity = useIdentityStore((state) => state.resetIdentity);

  return (
    <Screen bounces={false}>
      <View className="gap-1">
        <Text variant="title">Profile</Text>
        <Text className="text-foreground-secondary" variant="caption">
          Manage your identity on this device.
        </Text>
      </View>

      <View className="gap-2">
        <SectionLabel>Identity</SectionLabel>
        <Surface
          className="gap-1 rounded-xl border border-background-selected p-4"
          tone="element"
        >
          <Text variant="large">@{identity?.handle}</Text>
          <Text className="text-foreground-secondary" variant="caption">
            Stored securely on this device
          </Text>
        </Surface>
      </View>

      <View className="gap-2">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button className="h-12 rounded-xl" variant="destructive">
              <Text>Log out</Text>
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Log out on this device?</AlertDialogTitle>
              <AlertDialogDescription>
                For now, logging out deletes the local identity and keys from
                this device. Only continue if you have saved the recovery key.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel accessibilityLabel="Cancel logout">
                <Text>Cancel</Text>
              </AlertDialogCancel>
              <AlertDialogAction
                accessibilityLabel="Log out and delete local identity"
                className="bg-destructive"
                onPress={() => void resetIdentity()}
              >
                <Text className="text-white">Log out</Text>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Text
          className="text-center text-foreground-secondary"
          variant="caption"
        >
          You will need your recovery key to restore this identity.
        </Text>
      </View>
    </Screen>
  );
};

export default ProfileScreen;
